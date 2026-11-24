import ExpoModulesCore
import UIKit

/// A request to clear the field if its text has not changed since `revision`. Each new `token` asks once.
struct ClearRequest: Record {
  @Field var revision: Int = 0
  @Field var token: Int = 0
}

/// A request to replace `start..<end`, in UTF-16 code units, with `replacement`, and put the caret at `caret`, only
/// while the field is just as its report numbered `sequence` saw it. Tokens only increase: one no greater than the last
/// answered asks nothing, so 0 never asks.
struct ReplaceRequest: Record {
  @Field var token: Int = 0
  @Field var revision: Int = 0
  @Field var sequence: Int = 0
  @Field var start: Int = 0
  @Field var end: Int = 0
  @Field var expected: String = ""
  @Field var replacement: String = ""
  @Field var caret: Int = 0
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
      Prop("replaceIf") { (view: ChatComposerView, value: ReplaceRequest) in view.replace(if: value) }
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

/// Whether UTF-16 offset `at` of `text` falls between characters' code units, not inside a surrogate pair.
private func boundary(_ text: NSString, _ at: Int) -> Bool {
  guard at > 0, at < text.length else { return true }
  return !(UTF16.isLeadSurrogate(text.character(at: at - 1)) && UTF16.isTrailSurrogate(text.character(at: at)))
}

/// A UITextView that says when its marked text starts, changes or ends. An input method can end it without changing
/// the text, as when it commits exactly what it composed, and the delegate hears nothing of that.
final class ComposerTextView: UITextView {
  var onMarkedText: (() -> Void)?

  override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
    super.setMarkedText(markedText, selectedRange: selectedRange)
    onMarkedText?()
  }

  override func unmarkText() {
    super.unmarkText()
    onMarkedText?()
  }
}

/// What a report says of the field, apart from its text, which only changes with `revision`.
private struct FieldState: Equatable {
  var revision: Int
  var selection: NSRange
  var composing: NSRange?
}

/// The composer's text field: a UITextView at the body text size, with Dynamic Type, and a placeholder label that
/// VoiceOver doesn't read, since the text view carries the field's own name. Return is a new line. It keeps its text,
/// reports each change to its text, selection and composition, and the height its text needs, and scrolls inside itself
/// once the screen caps its height.
final class ChatComposerView: ExpoView, UITextViewDelegate {
  let textView = ComposerTextView()
  private let placeholder = UILabel()
  private var clearToken = 0
  private var replaceToken = 0
  /// Counts every change to the text, the field's own clears included, so an edit away and back still counts.
  private var revision = 0
  /// The text `revision` counts, so each change counts once, whichever callback hears of it first.
  private var counted = ""
  /// Counts every report.
  private var sequence = 0
  /// What the last report said, so a selection or composition that didn't move reports nothing.
  private var reported: FieldState?
  /// Set while the field changes its own text, which it then reports once.
  private var quiet = false
  private var reportedHeight: CGFloat = 0
  /// Space above and below the text, outside the text view, so it stays put while the text scrolls.
  private let inset: CGFloat = 11
  let onChangeText = EventDispatcher()
  let onContentHeight = EventDispatcher()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let font = UIFont.preferredFont(forTextStyle: .body)
    textView.font = font
    textView.adjustsFontForContentSizeCategory = true
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.returnKeyType = .default
    // A status-bar tap scrolls the conversation, as React Native's own text view leaves it to.
    textView.scrollsToTop = false
    textView.delegate = self
    textView.onMarkedText = { [weak self] in
      guard let self = self, !self.quiet else { return }
      self.report()
    }
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
    recount()
    guard textView.markedTextRange == nil, revision == request.revision else {
      report(refused: request.token)
      return
    }
    quiet = true
    textView.text = ""
    quiet = false
    changed(cleared: request.token)
  }

  /// Replaces a range as one edit the person can undo, only if the field is just as the request saw it, and answers
  /// once either way. A refusal changes nothing and reports the field as it is.
  func replace(if request: ReplaceRequest) {
    guard request.token > replaceToken else { return }
    replaceToken = request.token
    recount()
    let text = (textView.text ?? "") as NSString
    let selection = textView.selectedRange
    guard textView.isEditable, textView.markedTextRange == nil,
      request.revision == revision, request.sequence == sequence,
      request.start >= 0, request.start <= request.end, request.end <= text.length,
      selection.location == request.end, selection.length == 0,
      boundary(text, request.start), boundary(text, request.end)
    else {
      report(replaced: (request.token, false))
      return
    }
    let range = NSRange(location: request.start, length: request.end - request.start)
    let next = text.replacingCharacters(in: range, with: request.replacement) as NSString
    guard text.substring(with: range).utf16.elementsEqual(request.expected.utf16),
      request.caret >= 0, request.caret <= next.length, boundary(next, request.caret),
      let from = textView.position(from: textView.beginningOfDocument, offset: request.start),
      let to = textView.position(from: from, offset: range.length),
      let span = textView.textRange(from: from, to: to)
    else {
      report(replaced: (request.token, false))
      return
    }
    // Through UITextInput, not `text`, so the edit joins the undo stack, grouped so one undo restores the query.
    quiet = true
    textView.undoManager?.beginUndoGrouping()
    textView.replace(span, withText: request.replacement)
    textView.selectedRange = NSRange(location: request.caret, length: 0)
    textView.undoManager?.endUndoGrouping()
    quiet = false
    changed(replaced: (request.token, true))
  }

  /// Shows `text`, a draft kept elsewhere, once, only while the field is still empty and unedited. It waits a turn of
  /// the main loop, until the field is mounted and can report, then reports it as an edit, with a new revision.
  func seed(_ text: String) {
    guard !text.isEmpty else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.revision == 0, self.textView.text.isEmpty else { return }
      self.quiet = true
      self.textView.text = text
      self.quiet = false
      self.changed()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds.insetBy(dx: 0, dy: inset)
    let line = ceil(placeholder.font.lineHeight)
    placeholder.frame = CGRect(x: 0, y: inset, width: bounds.width, height: line)
    reportHeight()
  }

  // A Text Size change resizes the text without laying out the host. The app supports iOS 16.4, before the
  // trait-registration API.
  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { setNeedsLayout() }
  }

  // A selection callback can come before the text callback for the same edit; whichever comes first counts the text.
  func textViewDidChange(_ textView: UITextView) {
    guard !quiet else { return }
    report()
    reportHeight()
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    guard !quiet else { return }
    report()
  }

  /// The field's own change to its text, which counts as one revision, even when the text comes out the same.
  /// `cleared` is the token of the request whose clear made this change, or 0 for a seed or replacement.
  private func changed(cleared: Int = 0, replaced: (token: Int, applied: Bool)? = nil) {
    counted = textView.text ?? ""
    revision += 1
    report(cleared: cleared, replaced: replaced)
    reportHeight()
  }

  /// Counts the text as a new revision when it differs, code unit for code unit, from the text last counted.
  private func recount() {
    let text = textView.text ?? ""
    placeholder.isHidden = !text.isEmpty
    guard !text.utf16.elementsEqual(counted.utf16) else { return }
    counted = text
    revision += 1
  }

  /// The field's state, in UTF-16 offsets, as NSString and UITextInput count them.
  private func state() -> FieldState {
    let length = ((textView.text ?? "") as NSString).length
    var selection = textView.selectedRange
    if selection.location == NSNotFound || NSMaxRange(selection) > length {
      selection = NSRange(location: length, length: 0)
    }
    var composing: NSRange?
    if let marked = textView.markedTextRange {
      let start = textView.offset(from: textView.beginningOfDocument, to: marked.start)
      let end = textView.offset(from: textView.beginningOfDocument, to: marked.end)
      composing = NSRange(location: start, length: max(0, end - start))
    }
    return FieldState(revision: revision, selection: selection, composing: composing)
  }

  /// Reports the field, its text counted first, so a report's text is always the text at its revision. An answer to a
  /// request always reports; otherwise only a change since the last report does.
  private func report(cleared: Int = 0, refused: Int = 0, replaced: (token: Int, applied: Bool)? = nil) {
    recount()
    let now = state()
    guard cleared != 0 || refused != 0 || replaced != nil || now != reported else { return }
    reported = now
    sequence += 1
    var event: [String: Any] = [
      "text": textView.text ?? "",
      "revision": revision,
      "sequence": sequence,
      "selectionStart": now.selection.location,
      "selectionEnd": NSMaxRange(now.selection),
      "cleared": cleared,
      "refused": refused,
    ]
    if let composing = now.composing {
      event["composing"] = ["start": composing.location, "end": NSMaxRange(composing)]
    }
    if let replaced = replaced {
      event["replaced"] = ["token": replaced.token, "applied": replaced.applied]
    }
    onChangeText(event)
  }

  private func reportHeight() {
    guard bounds.width > 0 else { return }
    let fits = textView.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
    let height = ceil(fits.height) + 2 * inset
    if abs(height - reportedHeight) < 0.5 { return }
    reportedHeight = height
    onContentHeight(["height": height])
  }
}
