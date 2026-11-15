package app.dohc.chatcomposer

import android.content.Context
import android.graphics.Color
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.ceil

/** A request to clear the field if its text has not changed since `revision`. Each new `token` asks once. */
class ClearRequest : Record {
  @Field val revision: Int = 0
  @Field val token: Int = 0
}

/** A request to replace `start` until `end`, in UTF-16 code units, with `replacement`, and put the caret at `caret`, only
 * while the field is just as its report numbered `sequence` saw it. Each new `token` asks once. */
class ReplaceRequest : Record {
  @Field val token: Int = 0
  @Field val revision: Int = 0
  @Field val sequence: Int = 0
  @Field val start: Int = 0
  @Field val end: Int = 0
  @Field val expected: String = ""
  @Field val replacement: String = ""
  @Field val caret: Int = 0
}

class ChatComposerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatComposer")
    View(ChatComposerView::class) {
      Events("onChangeText", "onContentHeight")
      Prop("placeholder") { view: ChatComposerView, value: String -> view.field.hint = value }
      Prop("fieldLabel") { view: ChatComposerView, value: String -> view.label = value }
      Prop("editable") { view: ChatComposerView, value: Boolean -> view.setEditable(value) }
      Prop("textColor") { view: ChatComposerView, value: String -> parse(value)?.let { view.field.setTextColor(it) } }
      Prop("placeholderColor") { view: ChatComposerView, value: String ->
        parse(value)?.let { view.field.setHintTextColor(it) }
      }
      Prop("clearIf") { view: ChatComposerView, value: ClearRequest -> view.clearIf(value.revision, value.token) }
      Prop("replaceIf") { view: ChatComposerView, value: ReplaceRequest -> view.replaceIf(value) }
      Prop("initialText") { view: ChatComposerView, value: String -> view.seed(value) }
    }
  }
}

/** `#rrggbb`, as the theme writes its colors, or null for anything else. */
private fun parse(hex: String): Int? =
  if (Regex("#[0-9a-fA-F]{6}").matches(hex)) Color.parseColor(hex) else null

/** Whether UTF-16 offset `at` of `text` falls between characters' code units, not inside a surrogate pair. */
private fun boundary(text: CharSequence, at: Int): Boolean =
  at <= 0 || at >= text.length || !(Character.isHighSurrogate(text[at - 1]) && Character.isLowSurrogate(text[at]))

/** An EditText that says when its selection moves, or its input method starts, changes or ends composing. An input
 * method can end composing without changing the text, as when it commits exactly what it composed, and no text
 * watcher hears that. */
class ComposerEditText(context: Context) : EditText(context) {
  // TextView's constructor moves the selection before this is set; the call then finds it null.
  var onEditingState: (() -> Unit)? = null

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    onEditingState?.invoke()
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val connection = super.onCreateInputConnection(outAttrs) ?: return null
    return object : InputConnectionWrapper(connection, true) {
      override fun setComposingText(text: CharSequence?, newCursorPosition: Int) =
        after(super.setComposingText(text, newCursorPosition))
      override fun setComposingRegion(start: Int, end: Int) = after(super.setComposingRegion(start, end))
      override fun finishComposingText() = after(super.finishComposingText())
      override fun commitText(text: CharSequence?, newCursorPosition: Int) =
        after(super.commitText(text, newCursorPosition))
      override fun endBatchEdit() = after(super.endBatchEdit())

      private fun after(result: Boolean): Boolean {
        onEditingState?.invoke()
        return result
      }
    }
  }
}

/** The composer's text field: an EditText at the body text size, which follows the system font scale. Return is a new
 * line. It keeps its text, reports each change to its text, selection and composition, and the height its text needs,
 * and scrolls inside itself once the screen caps its height. */
class ChatComposerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  val field = ComposerEditText(context)
  /** The field's accessible name, which stays when the hint goes. */
  var label: String = ""
  private var clearToken = 0
  private var replaceToken = 0
  /** Counts every change to the text, the field's own clears included, so an edit away and back still counts. */
  private var revision = 0
  /** Counts every report. */
  private var sequence = 0
  /** What the last report said, so a selection or composition that didn't move reports nothing. */
  private var reported: FieldState? = null
  /** Set while the field changes its own text, which it then reports once. */
  private var quiet = false
  private var reportedHeight = 0f
  private val onChangeText by EventDispatcher()
  private val onContentHeight by EventDispatcher()
  private val density = resources.displayMetrics.density

  /** What a report says of the field, apart from its text, which only changes with `revision`. A composing start of -1
   * means nothing is being composed. */
  private data class FieldState(
    val revision: Int,
    val selectionStart: Int,
    val selectionEnd: Int,
    val composingStart: Int,
    val composingEnd: Int,
  )

  init {
    field.inputType =
      InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    field.isSingleLine = false
    field.setHorizontallyScrolling(false)
    field.gravity = Gravity.TOP or Gravity.START
    field.background = null
    field.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
    val vertical = (11 * density).toInt()
    field.setPadding(0, vertical, 0, vertical)
    field.setAccessibilityDelegate(object : View.AccessibilityDelegate() {
      override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(host, info)
        if (label.isNotEmpty() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) info.hintText = label
      }
    })
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(text: Editable?) {
        revision += 1
        if (!quiet) report()
        field.post { reportHeight() }
      }
    })
    field.onEditingState = { if (!quiet) report() }
    addView(field, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setEditable(editable: Boolean) {
    field.isEnabled = editable
  }

  /** Clears the field only if its text has not changed since it was sent, at `sent`, so text typed meanwhile stays. A
   * request it refuses, for that text or for text still being composed, it reports without changing anything. */
  fun clearIf(sent: Int, token: Int) {
    if (token == clearToken) return
    clearToken = token
    if (sent != revision || state().composingStart >= 0) {
      report(refused = token)
      return
    }
    // setText raises the revision through the watcher before it returns.
    quietly { field.setText("") }
    report(cleared = token)
  }

  /** Replaces a range as one edit the person can undo, only if the field is just as the request saw it, and answers
   * once either way. A refusal changes nothing and reports the field as it is. */
  fun replaceIf(request: ReplaceRequest) {
    if (request.token == replaceToken) return
    replaceToken = request.token
    val text = field.text
    val now = state()
    val fits = field.isEnabled && now.composingStart < 0 &&
      request.revision == revision && request.sequence == sequence &&
      request.start >= 0 && request.start <= request.end && request.end <= text.length &&
      now.selectionStart == request.end && now.selectionEnd == request.end &&
      boundary(text, request.start) && boundary(text, request.end) &&
      text.subSequence(request.start, request.end).toString() == request.expected
    val next = if (fits) StringBuilder(text).replace(request.start, request.end, request.replacement) else null
    if (next == null || request.caret < 0 || request.caret > next.length || !boundary(next, request.caret)) {
      report(replaced = mapOf("token" to request.token, "applied" to false))
      return
    }
    // An edit of the field's own Editable, in one batch, so its undo takes it back as one step; setText would not.
    quietly {
      field.beginBatchEdit()
      text.replace(request.start, request.end, request.replacement)
      field.setSelection(request.caret)
      field.endBatchEdit()
    }
    report(replaced = mapOf("token" to request.token, "applied" to true))
  }

  /** Shows `text`, a draft kept elsewhere, once, only while the field is still empty and unedited. It waits until the
   * field is attached and can report, then reports it as an edit, with a new revision. */
  fun seed(text: String) {
    if (text.isEmpty()) return
    field.post {
      if (revision != 0 || field.text.isNotEmpty()) return@post
      quietly {
        field.setText(text)
        field.setSelection(field.text.length)
      }
      report()
    }
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    if (width != oldWidth) post { reportHeight() }
  }

  private fun quietly(edit: () -> Unit) {
    quiet = true
    try {
      edit()
    } finally {
      quiet = false
    }
  }

  /** The field's state, in UTF-16 offsets, as Java strings count them. */
  private fun state(): FieldState {
    val text = field.text
    val length = text.length
    val a = field.selectionStart
    val b = field.selectionEnd
    val start = if (a < 0 || b < 0) length else minOf(a, b)
    val end = if (a < 0 || b < 0) length else maxOf(a, b)
    val c = BaseInputConnection.getComposingSpanStart(text)
    val d = BaseInputConnection.getComposingSpanEnd(text)
    val composing = c >= 0 && d >= 0
    return FieldState(
      revision,
      start,
      end,
      if (composing) minOf(c, d) else -1,
      if (composing) maxOf(c, d) else -1,
    )
  }

  /** Reports the field. An answer to a request always reports; otherwise only a change since the last report does. */
  private fun report(cleared: Int = 0, refused: Int = 0, replaced: Map<String, Any>? = null) {
    val now = state()
    if (cleared == 0 && refused == 0 && replaced == null && now == reported) return
    reported = now
    sequence += 1
    val event = mutableMapOf<String, Any>(
      "text" to field.text.toString(),
      "revision" to revision,
      "sequence" to sequence,
      "selectionStart" to now.selectionStart,
      "selectionEnd" to now.selectionEnd,
      "cleared" to cleared,
      "refused" to refused,
    )
    if (now.composingStart >= 0) event["composing"] = mapOf("start" to now.composingStart, "end" to now.composingEnd)
    if (replaced != null) event["replaced"] = replaced
    onChangeText(event)
  }

  private fun reportHeight() {
    if (width <= 0) return
    field.measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
    )
    val height = ceil(field.measuredHeight / density)
    if (kotlin.math.abs(height - reportedHeight) < 0.5f) return
    reportedHeight = height
    onContentHeight(mapOf("height" to height))
    // The field keeps the height Yoga gives it; measuring it for its text must not leave that measure behind.
    requestLayout()
  }
}
