import ExpoModulesCore
import UIKit
import WebKit
import os

private let log = Logger(subsystem: "app.dohc.mobile", category: "page-scroll-top")

public final class PageScrollTopModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PageScrollTop")
    View(PageScrollTopHost.self) {
      Prop("active") { (view: PageScrollTopHost, active: Bool) in view.setActive(active) }
      Prop("ready") { (view: PageScrollTopHost, ready: Bool) in view.setReady(ready) }
    }
  }
}

/// Holds a page's web view, its only React child. The page scrolls inside an element, which the status-bar tap can't
/// reach, and iOS ignores the tap when more than one scroll view on screen takes it. So the host stops every scroll view
/// under it from taking the tap and adds one that does, the receiver. The receiver tells the page to scroll to its top
/// and refuses the tap, so it never moves and takes the next tap too. The host changes nothing else about the web view
/// and looks at nothing outside itself.
final class PageScrollTopHost: ExpoView, UIScrollViewDelegate {
  private let receiver = Receiver()
  private weak var webView: WKWebView?
  private var active = false
  private var ready = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    // iOS may skip a scroll view that is hidden, clear to nothing, empty or already at its top, so the receiver is a
    // real 1 pt tall view resting 1 pt down its content. It spans the host's width (layoutSubviews): UIKit scrolls the
    // flagged scroll view beneath the tap, and the test taps the bar's middle. It stays the last subview: React
    // Native mounts and unmounts children by index from the first.
    receiver.backgroundColor = .clear
    receiver.contentInsetAdjustmentBehavior = .never
    receiver.showsVerticalScrollIndicator = false
    receiver.showsHorizontalScrollIndicator = false
    receiver.scrollsToTop = false
    receiver.isAccessibilityElement = false
    receiver.accessibilityElementsHidden = true
    receiver.delegate = self
    addSubview(receiver)
  }

  func setActive(_ value: Bool) {
    active = value
    bind()
  }

  /// react-native-webview makes its WKWebView only once it's in a window, so the host looks again when the page is ready.
  func setReady(_ value: Bool) {
    ready = value
    bind()
    // One line per readiness change, so a host that never arms shows which input was missing.
    log.notice(
      "ready \(value, privacy: .public): active \(self.active, privacy: .public), window \(self.window != nil, privacy: .public), web view \(self.bound, privacy: .public)"
    )
  }

  override func didAddSubview(_ subview: UIView) {
    super.didAddSubview(subview)
    bind()
  }

  override func willRemoveSubview(_ subview: UIView) {
    super.willRemoveSubview(subview)
    if let webView, webView.isDescendant(of: subview) { self.webView = nil }
    arm()
  }

  // WebKit can add scroll views inside the web view after it's bound, so each layout looks again.
  override func layoutSubviews() {
    super.layoutSubviews()
    let width = max(bounds.width, 1)
    if receiver.frame.width != width {
      receiver.frame = CGRect(x: 0, y: 0, width: width, height: 1)
      receiver.contentSize = CGSize(width: width, height: 2)
      receiver.contentOffset = CGPoint(x: 0, y: 1)
    }
    bind()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { bind() } else { arm() }
  }

  private var bound: Bool { webView?.isDescendant(of: self) == true }

  private func bind() {
    if !bound { webView = firstWebView(in: self) }
    quiet(self)
    arm()
  }

  /// Only the page in front, drawn and in a window, takes the tap.
  private func arm() {
    let armed = active && ready && window != nil && bound
    if armed == receiver.scrollsToTop { return }
    receiver.scrollsToTop = armed
    guard armed else { return log.notice("disarmed") }
    // A snapshot of the flags when it arms, the receiver included: more than one suggests another scroll view competes.
    let flagged = window.map { flaggedForTheTap(in: $0) } ?? 0
    log.notice("armed; scroll views in the window flagged for the tap: \(flagged, privacy: .public)")
  }

  /// Every scroll view under the host but the receiver: the web view's own, and any WebKit adds for the page's element.
  private func quiet(_ view: UIView) {
    for subview in view.subviews where subview !== receiver {
      if let scroll = subview as? UIScrollView { scroll.scrollsToTop = false }
      quiet(subview)
    }
  }

  private func flaggedForTheTap(in view: UIView) -> Int {
    view.subviews.reduce(0) { count, subview in
      count + ((subview as? UIScrollView)?.scrollsToTop == true ? 1 : 0) + flaggedForTheTap(in: subview)
    }
  }

  private func firstWebView(in view: UIView) -> WKWebView? {
    for subview in view.subviews {
      if let found = (subview as? WKWebView) ?? firstWebView(in: subview) { return found }
    }
    return nil
  }

  func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
    guard scrollView === receiver, receiver.scrollsToTop, let webView, bound else {
      log.notice("status bar tap refused: receiver \(scrollView === self.receiver, privacy: .public)")
      return false
    }
    log.notice("status bar tap: scrolling the page to its top")
    webView.evaluateJavaScript("typeof window.__dohcScrollToTop === 'function' && (window.__dohcScrollToTop(), true)") { result, error in
      log.notice(
        "page scroll to top: \(error == nil ? "ran" : "failed", privacy: .public), function present \((result as? Bool) == true, privacy: .public)"
      )
    }
    return false
  }
}

/// Takes the status-bar tap and no touch: touches go through it to the page.
private final class Receiver: UIScrollView {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
}
