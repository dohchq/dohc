import ExpoModulesCore
import UIKit
import WebKit

public final class EditorPoolModule: Module {
  public func definition() -> ModuleDefinition {
    Name("EditorPool")
    Events("spareReady")
    AsyncFunction("prepare") { (page: String, folder: String, rewritten: Bool) in
      guard let page = URL(string: page), let folder = URL(string: folder) else { return }
      MainActor.assumeIsolated {
        EditorPool.shared.spareChanged = { [weak self] ready in
          self?.sendEvent("spareReady", ["ready": ready])
        }
        EditorPool.shared.prepare(page: page, folder: folder, rewritten: rewritten)
      }
    }.runOnQueue(.main)
    AsyncFunction("keepSpare") { (on: Bool) in
      MainActor.assumeIsolated { EditorPool.shared.keepSpare(on) }
    }.runOnQueue(.main)
    View(EditorSlot.self) {
      Events("onMessage", "onLost", "onClaim")
      Prop("source") { (view: EditorSlot, value: String) in view.source = URL(string: value) }
      Prop("folder") { (view: EditorSlot, value: String) in view.folder = URL(string: value) }
      Prop("startScript") { (view: EditorSlot, value: String?) in view.startScript = value ?? "" }
      OnViewDidUpdateProps { (view: EditorSlot) in view.claim() }
      AsyncFunction("inject") { (view: EditorSlot, script: String) in
        MainActor.assumeIsolated { view.inject(script) }
      }.runOnQueue(.main)
    }
  }
}

final class EditorSlot: ExpoView {
  let onMessage = EventDispatcher()
  let onLost = EventDispatcher()
  let onClaim = EventDispatcher()
  var source: URL?
  var folder: URL?
  var startScript = ""
  private var editor: Editor?
  private var lost = false

  override func didMoveToWindow() {
    super.didMoveToWindow()
    claim()
  }

  func claim() {
    guard editor == nil, !lost, window != nil, let source, let folder else { return }
    guard let claimed = EditorPool.shared.claim(page: source, folder: folder) else {
      return editorLost()
    }
    let (editor, claim) = claimed
    self.editor = editor
    editor.webView.frame = bounds
    addSubview(editor.webView)
    onClaim(["kind": claim.rawValue])
    editor.attach(self)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    editor?.webView.frame = bounds
  }

  func editorStarted() {
    if !startScript.isEmpty { inject(startScript) }
  }

  func forward(_ data: String) {
    onMessage(["data": data])
  }

  func editorLost() {
    lost = true
    onLost()
  }

  func inject(_ script: String) {
    editor?.webView.evaluateJavaScript(script, completionHandler: nil)
  }

  deinit {
    let editor = editor
    Task { @MainActor in editor?.release() }
  }
}
