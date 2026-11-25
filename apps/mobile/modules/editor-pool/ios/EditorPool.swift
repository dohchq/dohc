import UIKit

@MainActor
final class EditorPool {
  static let shared = EditorPool()

  var spareChanged: ((_ ready: Bool) -> Void)?
  private var page: URL?
  private var folder: URL?
  private var spare: Editor?
  private var failedPage: URL?
  private var keeping = false
  private var unsettled = 0
  private var timer: Timer?
  private var shelf: UIView?

  private init() {
    let center = NotificationCenter.default
    center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) {
      [weak self] _ in MainActor.assumeIsolated { self?.schedule() }
    }
    center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) {
      [weak self] _ in MainActor.assumeIsolated { self?.stopTimer() }
    }
    center.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.drop()
        self?.schedule()
      }
    }
  }

  func prepare(page: URL, folder: URL, rewritten: Bool) {
    let page = normalized(page)
    let folder = normalized(folder)
    if rewritten || spare?.page != page || spare?.folder != folder { drop() }
    if rewritten || page != self.page { failedPage = nil }
    self.page = page
    self.folder = folder
    schedule()
  }

  func keepSpare(_ on: Bool) {
    keeping = on
    if on {
      schedule()
    } else {
      stopTimer()
      drop()
    }
  }

  func claim(page: URL, folder: URL) -> (Editor, Claim)? {
    let page = normalized(page)
    let folder = normalized(folder)
    guard page.path.hasPrefix(folder.path + "/") else { return nil }
    if let spare, !exists(spare.page) { drop() }
    let editor: Editor
    let claim: Claim
    if let spare, spare.page == page, spare.folder == folder {
      self.spare = nil
      spareChanged?(false)
      editor = spare
      claim = spare.ready ? .ready : .loading
    } else {
      editor = Editor(page: page, folder: folder)
      claim = .cold
    }
    stopTimer()
    unsettled += 1
    editor.onSettle = { [weak self] in
      self?.unsettled -= 1
      self?.schedule()
    }
    return (editor, claim)
  }

  private func schedule() {
    stopTimer()
    guard canRefill else { return }
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.refill() }
    }
  }

  private func stopTimer() {
    timer?.invalidate()
    timer = nil
  }

  private var canRefill: Bool {
    keeping && spare == nil && unsettled == 0 && page != nil && page != failedPage
      && UIApplication.shared.applicationState == .active
  }

  private func refill() {
    guard canRefill, let page, let folder, exists(page), let window = keyWindow() else { return }
    let editor = Editor(page: page, folder: folder)
    editor.onReady = { [weak self, weak editor] in
      guard let self, let editor, self.spare === editor else { return }
      quiet(editor.webView)
      self.spareChanged?(true)
    }
    editor.onLost = { [weak self, weak editor] ended in
      guard let self, self.spare === editor else { return }
      self.drop()
      if !ended { self.failedPage = page }
      self.schedule()
    }
    let shelf = shelf(in: window)
    editor.webView.frame = shelf.bounds
    shelf.addSubview(editor.webView)
    spare = editor
  }

  private func drop() {
    guard let spare else { return }
    self.spare = nil
    spare.release()
    spareChanged?(false)
  }

  private func exists(_ page: URL) -> Bool {
    FileManager.default.fileExists(atPath: page.path)
  }

  private func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows).first(where: \.isKeyWindow)
  }

  private func shelf(in window: UIWindow) -> UIView {
    if let shelf, shelf.window === window { return shelf }
    let shelf = UIView(frame: window.bounds)
    shelf.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    shelf.isUserInteractionEnabled = false
    shelf.accessibilityElementsHidden = true
    shelf.alpha = 0
    window.insertSubview(shelf, at: 0)
    self.shelf = shelf
    return shelf
  }
}

private func quiet(_ view: UIView) {
  for subview in view.subviews {
    (subview as? UIScrollView)?.scrollsToTop = false
    quiet(subview)
  }
}
