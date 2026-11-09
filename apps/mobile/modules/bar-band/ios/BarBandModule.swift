import ExpoModulesCore
import UIKit
import UIKit.UIGestureRecognizerSubclass

public final class BarBandModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BarBand")
    View(BarBandHost.self) {
      Events("onSpace")
      Prop("coverHeight") { (view: BarBandHost, height: Double) in view.cover(CGFloat(height)) }
    }
  }
}

/// Holds a list, its first child, and the band drawn over it, its second. It does four things and draws nothing: it
/// tells iOS the band's strip is covered, through its screen's safe area; it keeps the band's bottom on the list's
/// content top, no higher than the folded bar; it has VoiceOver read the band before the list; and it reports the space
/// between the bar's resting edge and the tab bar, which caps the band's height. The list stays the first child, so the
/// large title still folds with it. Keep the host to layout styles: a shadow, an outline or clipping wraps its children in
/// one view.
final class BarBandHost: ExpoView {
  private var coverHeight: CGFloat = 0
  private var appliedHeight: CGFloat = 0
  /// Where the list was when the screen last left its window, to put it back on return.
  private var left: (offset: CGFloat, atTop: Bool, atEnd: Bool)?
  /// Settling: after a return, while iOS corrects the list's inset, a list that was at its end stays at the new end and
  /// none goes past it. A touch, a band change, any other scroll, or a second ends it. The offset is where the list was
  /// at the last settled callback, so a callback that didn't move it isn't taken for someone else's scroll. A script
  /// scroll that lands exactly where the list already is can't be told from such a callback, so it doesn't end settling.
  private var settling: (toEnd: Bool, inset: CGFloat, offset: CGFloat)?
  private var settleCount = 0
  private var clamping = false
  private weak var screen: UIViewController?
  /// The band and the list, kept as they're added, so placing the band on each scroll frame reads no view arrays. The
  /// band's translation comes off as it's removed, before React Native reuses the view elsewhere.
  private weak var band: UIView?
  private weak var watchedList: UIScrollView?
  private var offsetWatch: NSKeyValueObservation?
  /// The space last reported, so a change under 1 pt, or a fold, sends nothing.
  private var reportedSpace: CGFloat?
  /// The bar's open height, for the width and Text Size it was asked at.
  private var openHeight: (width: CGFloat, size: UIContentSizeCategory, height: CGFloat)?
  let onSpace = EventDispatcher()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    // A finger landing on the host ends settling, even one that rests without moving the list.
    addGestureRecognizer(TouchWatcher { [weak self] in self?.settling = nil })
  }

  /// A Text Size change resizes the large title, and so the space, without laying out the host. The app supports iOS
  /// 16.4, before the trait-registration API.
  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { setNeedsLayout() }
  }

  /// VoiceOver reads the band before the list while the band shows, and the default order otherwise. Set, not
  /// computed, when the band comes or goes, so UIKit drops the order it cached. Then VoiceOver is told the layout
  /// changed, without moving focus. Only while on screen: elsewhere it would re-read whatever screen the person is on.
  private func setReadOrder(without leaving: UIView? = nil) {
    let present = subviews.filter { $0 !== leaving }
    accessibilityElements = present.count > 1 ? Array(present.dropFirst()) + [present[0]] : nil
    if window != nil { UIAccessibility.post(notification: .layoutChanged, argument: nil) }
  }

  func cover(_ height: CGFloat) {
    coverHeight = height
    if window != nil { setCovered(height) }
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    // Leaving the window, the screen gives the strip back, so nothing else on it moves while it's away. The list's place
    // is kept, so it can be put back on return, whatever iOS does to the offset meanwhile.
    if newWindow == nil {
      if let list = firstScrollView() {
        left = (list.contentOffset.y, list.contentOffset.y <= -list.adjustedContentInset.top + 0.5, list.contentOffset.y >= end(of: list) - 1)
      }
      settling = nil
      setCovered(0, moving: false)
      watch(nil)
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else { return }
    screen = owningScreen()
    // The first time in, the list has no place to come back to, so it moves as for any change.
    setCovered(coverHeight, moving: left == nil)
    // The list comes back where it was. If the band changed while away, iOS's own correction of the inset then moves it
    // once by the change, as the band does on screen (round 56's trace), so the host doesn't move it again.
    if let was = left, let list = firstScrollView() {
      screen?.view.layoutIfNeeded()
      scroll(list, to: was.atTop ? -list.adjustedContentInset.top : was.offset)
      settling = (was.atEnd, list.adjustedContentInset.top, list.contentOffset.y)
      settleCount += 1
      let count = settleCount
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
        guard let self, self.settleCount == count, let last = self.settling, let list = self.watchedList else { return }
        if !list.isTracking { self.settle(list, toEnd: last.toEnd) }
        self.settling = nil
      }
    }
    left = nil
    watch(firstScrollView())
    placeBand()
    reportSpace()
  }

  override func didAddSubview(_ subview: UIView) {
    super.didAddSubview(subview)
    band = subviews.count > 1 ? subviews[1] : nil
    if window != nil { watch(firstScrollView()) }
    placeBand()
    setReadOrder()
  }

  override func willRemoveSubview(_ subview: UIView) {
    if subview === band {
      subview.transform = .identity
      band = nil
    }
    super.willRemoveSubview(subview)
    if let list = watchedList, list.isDescendant(of: subview) { watch(nil) }
    setReadOrder(without: subview)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if window != nil { watch(firstScrollView()) }
    placeBand()
    reportSpace()
  }

  /// A Text Size change resizes the bar, and so the list's top inset, after the host's own layout.
  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    reportSpace()
  }

  /// Places the band on every change of the list's offset, in the same frame as the scroll: a drag, momentum, a fold,
  /// a pull-down, or the host's own moves. Only while on screen.
  private func watch(_ list: UIScrollView?) {
    guard list !== watchedList else { return }
    offsetWatch?.invalidate()
    offsetWatch = list?.observe(\.contentOffset, options: []) { [weak self] _, _ in self?.offsetChanged() }
    watchedList = list
  }

  /// Each scroll frame: place the band, and only while iOS corrects the list's inset after a return, settle the list. A
  /// move without an inset change is someone else's scroll, so settling ends and the move stays. iOS also calls back
  /// with the list where it was, between its corrections (round 54's trace); that isn't a move, so settling goes on.
  private func offsetChanged() {
    placeBand()
    guard let last = settling, !clamping, let list = watchedList else { return }
    guard !list.isTracking else { settling = nil; return }
    let insetChange = list.adjustedContentInset.top - last.inset, offsetChange = list.contentOffset.y - last.offset
    guard abs(insetChange) > 0.5 else {
      // Any real move ends it, a third of a point included; only a callback with the list where it was doesn't.
      if abs(offsetChange) > 0.01 { settling = nil }
      return
    }
    // iOS's correction moves the offset by exactly the inset's change, the other way (rounds 54 to 56). A move with an
    // inset change that doesn't match is someone else's scroll landing with it (a finger, VoiceOver, a status-bar tap, a
    // script), so settling ends and the move stays.
    guard abs(offsetChange + insetChange) <= 1 else { settling = nil; return }
    settle(list, toEnd: last.toEnd)
    // Read after the clamp: if moving the offset made iOS change the inset again, the next comparison starts from it.
    if settling != nil { settling = (last.toEnd, list.adjustedContentInset.top, list.contentOffset.y) }
  }

  /// A list that was at its end goes to the new end; any other list stays where iOS put it, within its ends.
  private func settle(_ list: UIScrollView, toEnd: Bool) {
    clamping = true
    scroll(list, to: toEnd ? end(of: list) : list.contentOffset.y)
    clamping = false
  }

  /// Covers the strip through the screen's own safe area, and moves the list's content by exactly the change, once. A
  /// list resting at its top stays at its top, which also holds before iOS has given it its first inset. The list stays
  /// within its ends: near the bottom, the band leaving can't leave a gap above the tab bar. Leaving and returning to
  /// the window don't move it here; the list's place is kept and put back instead.
  private func setCovered(_ height: CGFloat, moving: Bool = true) {
    guard let screen, height != appliedHeight else { return }
    let list = firstScrollView()
    let before = list?.contentOffset.y
    let atTop = list.map { $0.contentOffset.y <= -$0.adjustedContentInset.top + 0.5 } ?? false
    let change = height - appliedHeight
    settling = nil
    appliedHeight = height
    screen.additionalSafeAreaInsets.top = height
    screen.view.layoutIfNeeded()
    defer { placeBand() }
    guard moving, let list, let before else { return }
    scroll(list, to: atTop ? -list.adjustedContentInset.top : before - change)
  }

  private func end(of list: UIScrollView) -> CGFloat {
    max(-list.adjustedContentInset.top, list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height)
  }

  /// Sets the list's offset, kept between its top and its end.
  private func scroll(_ list: UIScrollView, to y: CGFloat) {
    let target = min(max(y, -list.adjustedContentInset.top), end(of: list))
    if abs(list.contentOffset.y - target) > 0.5 { list.contentOffset.y = target }
  }

  /// The band's bottom sits on the list's content top, so partway through a fold the band moves up with the title and
  /// the first row, and on a pull-down it moves down with the list. Once the bar has folded, the band stays at the
  /// bar's bottom and rows scroll under it. Runs on every scroll frame: it reads and sets, and allocates nothing.
  private func placeBand() {
    guard let band, let top = bandTop() else { return }
    let laidOutTop = band.center.y - band.bounds.height / 2
    let shift = CGAffineTransform(translationX: 0, y: top - laidOutTop)
    if band.transform != shift { band.transform = shift }
  }

  private func bandTop() -> CGFloat? {
    guard let bar = screen?.navigationController?.navigationBar, !bar.isHidden else { return nil }
    // Before iOS gives the list its first inset, the bar is at rest.
    let resting = restingEdge(of: bar)
    guard let list = watchedList, list.adjustedContentInset.top > appliedHeight else { return resting }
    let contentTop = list.convert(CGPoint.zero, to: self).y - appliedHeight
    // Partway through the fold the bar's frame still ends at the resting edge, and the band rides on the list. Once the
    // title has folded, the frame ends at the folded edge, and the band never goes above it.
    let barBottom = bar.convert(bar.bounds, to: self).maxY
    return barBottom < resting - 1 ? max(contentTop, barBottom) : contentTop
  }

  /// Where the bar's bottom is with the title open: its top plus the height it asks for open, at any scroll and any
  /// Text Size (round 52b's probe). The band is placed on each scroll frame, so the height is asked for again only when
  /// the bar's width or the Text Size changes.
  private func restingEdge(of bar: UINavigationBar) -> CGFloat {
    let width = bar.bounds.width, size = traitCollection.preferredContentSizeCategory
    if openHeight?.width != width || openHeight?.size != size {
      openHeight = (width, size, bar.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    }
    return bar.convert(bar.bounds, to: self).minY + (openHeight?.height ?? 0)
  }

  /// The space from the bar's resting edge to the top of the screen's bottom safe area: the tab bar on a phone, the
  /// home indicator where the tab bar sits at the top, as on iPad. A fold doesn't change the resting edge, so scrolling
  /// sends nothing.
  private func reportSpace() {
    guard window != nil, let view = screen?.view else { return }
    guard let bar = screen?.navigationController?.navigationBar, !bar.isHidden else { return }
    let restingEdge = self.restingEdge(of: bar)
    let space = view.convert(CGPoint(x: 0, y: view.bounds.maxY - view.safeAreaInsets.bottom), to: self).y - restingEdge
    guard space > 0, abs(space - (reportedSpace ?? -1)) > 1 else { return }
    reportedSpace = space
    onSpace(["height": space])
  }

  private func owningScreen() -> UIViewController? {
    var responder: UIResponder? = self
    while let next = responder?.next {
      if let controller = next as? UIViewController { return controller }
      responder = next
    }
    return nil
  }

  private func firstScrollView() -> UIScrollView? {
    var view = subviews.first
    while let current = view {
      if let scroll = current as? UIScrollView { return scroll }
      view = current.subviews.first
    }
    return nil
  }
}

/// Tells the host a finger landed, then fails at once: it never recognizes, delays or cancels anything, and runs
/// alongside every other recognizer, so the list and its rows get every touch as before.
private final class TouchWatcher: UIGestureRecognizer, UIGestureRecognizerDelegate {
  private let landed: () -> Void

  init(landed: @escaping () -> Void) {
    self.landed = landed
    super.init(target: nil, action: nil)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
    delegate = self
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    landed()
    state = .failed
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    true
  }
}
