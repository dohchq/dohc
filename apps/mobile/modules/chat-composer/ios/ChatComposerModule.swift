import ExpoModulesCore
import UIKit

/// A request to clear the field if its text has not changed since `revision`. Each new `token` asks once.
struct ClearRequest: Record {
  @Field var revision: Int = 0
  @Field var token: Int = 0
}

public final class ChatComposerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatComposer")
    View(ChatComposerView.self) {
      Events("onChangeText", "onContentHeight")
      Prop("placeholder") { (view: ChatComposerView, value: String) in view.setPlaceholder(value) }
      Prop("fieldLabel") { (view: ChatComposerView, value: String) in view.textView.accessibilityLabel = value }
      Prop("editable") { (view: ChatComposerView, value: Bool) in view.textView.isEditable = value }
      Prop("textColor") { (view: ChatComposerView, value: String) in view.textView.textColor = color(value) }
      Prop("placeholderColor") { (view: ChatComposerView, value: String) in view.setPlaceholderColor(color(value)) }
      Prop("clearIf") { (view: ChatComposerView, value: ClearRequest) in view.clear(if: value) }
      Prop("initialText") { (view: ChatComposerView, value: String) in view.seed(value) }
    }
  }
}

/// `#rrggbb`, as the theme writes its colors, or the system's label color for anything else.
private func color(_ hex: String) -> UIColor {
  guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return .label }
  return UIColor(
    red: CGFloat((value >> 16) & 0xff) / 255,
    green: CGFloat((value >> 8) & 0xff) / 255,
    blue: CGFloat(value & 0xff) / 255,
    alpha: 1
  )
}

/// The composer's text field: a UITextView at the body text size, with Dynamic Type, and a placeholder label that
/// VoiceOver doesn't read, since the text view carries the field's own name. Return is a new line. It keeps its text,
/// reports each change and the height its text needs, and scrolls inside itself once the screen caps its height.
final class ChatComposerView: ExpoView, UITextViewDelegate {
  let textView = UITextView()
  private let placeholder = UILabel()
  private var clearToken = 0
  /// Counts every change to the text, the field's own clears included, so an edit away and back still counts.
  private var revision = 0
  private var reportedHeight: CGFloat = 0
  let onChangeText = EventDispatcher()
  let onContentHeight = EventDispatcher()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let font = UIFont.preferredFont(forTextStyle: .body)
    textView.font = font
    textView.adjustsFontForContentSizeCategory = true
    textView.backgroundColor = .clear
    textView.textContainerInset = UIEdgeInsets(top: 11, left: 0, bottom: 11, right: 0)
    textView.textContainer.lineFragmentPadding = 0
    textView.returnKeyType = .default
    // A status-bar tap scrolls the conversation, as React Native's own text view leaves it to.
    textView.scrollsToTop = false
    textView.delegate = self
    placeholder.font = font
    placeholder.adjustsFontForContentSizeCategory = true
    placeholder.isAccessibilityElement = false
    placeholder.numberOfLines = 1
    addSubview(textView)
    addSubview(placeholder)
  }

  func setPlaceholder(_ text: String) {
    placeholder.text = text
    setNeedsLayout()
  }

  func setPlaceholderColor(_ color: UIColor) {
    placeholder.textColor = color
  }

  /// Clears the field only if its text has not changed since it was sent, so text typed meanwhile stays. A request it
  /// refuses, for that text or for text still being composed, it reports without changing anything.
  func clear(if request: ClearRequest) {
    guard request.token != clearToken else { return }
    clearToken = request.token
    guard textView.markedTextRange == nil, revision == request.revision else {
      onChangeText(["text": textView.text ?? "", "revision": revision, "cleared": 0, "refused": request.token])
      return
    }
    textView.text = ""
    changed(cleared: request.token)
  }

  /// Shows `text`, a draft kept elsewhere, once, only while the field is still empty and unedited. It waits a turn of
  /// the main loop, until the field is mounted and can report, then reports it as an edit, with a new revision.
  func seed(_ text: String) {
    guard !text.isEmpty else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.revision == 0, self.textView.text.isEmpty else { return }
      self.textView.text = text
      self.changed()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    let line = ceil(placeholder.font.lineHeight)
    placeholder.frame = CGRect(x: 0, y: textView.textContainerInset.top, width: bounds.width, height: line)
    reportHeight()
  }

  // A Text Size change resizes the text without laying out the host. The app supports iOS 16.4, before the
  // trait-registration API.
  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { setNeedsLayout() }
  }

  func textViewDidChange(_ textView: UITextView) {
    changed()
  }

  /// `cleared` is the token of the request whose clear made this change, or 0 for an edit.
  private func changed(cleared: Int = 0) {
    revision += 1
    placeholder.isHidden = !textView.text.isEmpty
    onChangeText(["text": textView.text ?? "", "revision": revision, "cleared": cleared, "refused": 0])
    reportHeight()
  }

  private func reportHeight() {
    guard bounds.width > 0 else { return }
    let fits = textView.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
    let height = ceil(fits.height)
    if abs(height - reportedHeight) < 0.5 { return }
    reportedHeight = height
    onContentHeight(["height": height])
  }
}
