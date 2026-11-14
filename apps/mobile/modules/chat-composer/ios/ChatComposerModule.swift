import ExpoModulesCore
import UIKit

/// A request to clear the field if it still holds `text`. Each new `token` asks once.
struct ClearRequest: Record {
  @Field var text: String = ""
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

  /// Clears the field only if it still holds the text that was sent, so text typed meanwhile stays.
  func clear(if request: ClearRequest) {
    guard request.token != clearToken else { return }
    clearToken = request.token
    guard textView.markedTextRange == nil, textView.text == request.text else { return }
    textView.text = ""
    changed()
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

  private func changed() {
    placeholder.isHidden = !textView.text.isEmpty
    onChangeText(["text": textView.text ?? ""])
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
