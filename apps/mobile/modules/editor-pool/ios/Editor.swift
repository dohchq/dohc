import UIKit
import WebKit

func normalized(_ url: URL) -> URL {
  url.standardizedFileURL.resolvingSymlinksInPath()
}

enum Claim: String {
  case ready, loading, cold
}

@MainActor
final class Editor: NSObject, WKNavigationDelegate, UIScrollViewDelegate {
  let page: URL
  let folder: URL
  let webView: WKWebView
  private var started: String?
  private var fontsLoaded = false
  private var lost = false
  weak var slot: EditorSlot?
  var onReady: (() -> Void)?
  var onLost: ((_ ended: Bool) -> Void)?
  var onSettle: (() -> Void)?

  var ready: Bool { started != nil && fontsLoaded }

  init(page: URL, folder: URL) {
    self.page = page
    self.folder = folder
    let controller = WKUserContentController()
    controller.addUserScript(
      WKUserScript(
        source: "window.ReactNativeWebView = { postMessage: (m) => webkit.messageHandlers.dohcEditor.postMessage(String(m)) };",
        injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let configuration = WKWebViewConfiguration()
    configuration.userContentController = controller
    configuration.dataDetectorTypes = []
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init()
    controller.add(Relay(self), name: "dohcEditor")
    for name in [
      UIResponder.keyboardWillShowNotification, UIResponder.keyboardWillHideNotification,
      UIResponder.keyboardWillChangeFrameNotification,
    ] {
      NotificationCenter.default.removeObserver(webView, name: name, object: nil)
    }
    webView.isOpaque = false
    webView.backgroundColor = .clear
    let scroll = webView.scrollView
    scroll.backgroundColor = .clear
    scroll.isScrollEnabled = false
    scroll.bounces = false
    scroll.scrollsToTop = false
    scroll.contentInsetAdjustmentBehavior = .never
    scroll.automaticallyAdjustsScrollIndicatorInsets = false
    scroll.delegate = self
    webView.navigationDelegate = self
    hideAccessoryBar(in: webView)
    webView.loadFileURL(page, allowingReadAccessTo: folder)
  }

  func attach(_ slot: EditorSlot) {
    self.slot = slot
    guard let started else { return }
    slot.editorStarted()
    slot.forward(started)
  }

  func release() {
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "dohcEditor")
    webView.navigationDelegate = nil
    webView.scrollView.delegate = nil
    webView.removeFromSuperview()
    settle()
  }

  fileprivate func received(_ data: String) {
    if data.hasPrefix(#"{"kind":"started""#) {
      started = data
      if fontsLoaded { onReady?() }
      slot?.editorStarted()
    } else if data.hasPrefix(#"{"kind":"fontsLoaded""#) {
      fontsLoaded = true
      if started != nil { onReady?() }
    } else if data.hasPrefix(#"{"kind":"painted""#) || data.hasPrefix(#"{"kind":"fontsFailed""#) {
      settle()
    }
    slot?.forward(data)
  }

  private func settle() {
    let settled = onSettle
    onSettle = nil
    settled?()
  }

  private func lose(ended: Bool) {
    guard !lost else { return }
    lost = true
    settle()
    if let slot { slot.editorLost() } else { onLost?(ended) }
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    let own = action.targetFrame?.isMainFrame == true && action.request.url.map { normalized($0).path } == page.path
    decisionHandler(own ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    failed(error as NSError)
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error
  ) {
    failed(error as NSError)
  }

  private func failed(_ error: NSError) {
    let cancelled =
      (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled)
      || (error.domain == "WebKitErrorDomain" && error.code == 102)
    if !cancelled || started == nil { lose(ended: false) }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    lose(ended: true)
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    scrollView.bounds = webView.bounds
  }
}

private final class Relay: NSObject, WKScriptMessageHandler {
  private weak var editor: Editor?

  init(_ editor: Editor) {
    self.editor = editor
  }

  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame, let data = message.body as? String else { return }
    MainActor.assumeIsolated { editor?.received(data) }
  }
}

// WebKit draws its own bar above the keyboard, which repeats the header's Done. WebKit has no public switch for it, so
// the editor's content view gets a subclass whose inputAccessoryView is nil. A KVO subclass is left alone.
private func hideAccessoryBar(in webView: WKWebView) {
  guard
    let content = webView.scrollView.subviews.first(where: {
      NSStringFromClass(type(of: $0)).hasPrefix("WKContent")
    })
  else { return }
  let base: AnyClass = type(of: content)
  let name = "DohcEditor_\(NSStringFromClass(base))"
  var subclass: AnyClass? = NSClassFromString(name)
  if subclass == nil, let made = objc_allocateClassPair(base, name, 0) {
    let none: @convention(block) (AnyObject) -> UIView? = { _ in nil }
    class_addMethod(
      made, #selector(getter: UIResponder.inputAccessoryView), imp_implementationWithBlock(none), "@@:")
    objc_registerClassPair(made)
    subclass = made
  }
  if let subclass { object_setClass(content, subclass) }
}
