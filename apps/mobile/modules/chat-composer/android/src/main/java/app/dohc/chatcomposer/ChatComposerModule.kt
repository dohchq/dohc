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
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.ceil

/** A request to clear the field if it still holds `text`. Each new `token` asks once. */
class ClearRequest : Record {
  @Field val text: String = ""
  @Field val token: Int = 0
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
      Prop("clearIf") { view: ChatComposerView, value: ClearRequest -> view.clearIf(value.text, value.token) }
    }
  }
}

/** `#rrggbb`, as the theme writes its colors, or null for anything else. */
private fun parse(hex: String): Int? =
  if (Regex("#[0-9a-fA-F]{6}").matches(hex)) Color.parseColor(hex) else null

/** The composer's text field: an EditText at the body text size, which follows the system font scale. Return is a new
 * line. It keeps its text, reports each change and the height its text needs, and scrolls inside itself once the screen
 * caps its height. */
class ChatComposerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  val field = EditText(context)
  /** The field's accessible name, which stays when the hint goes. */
  var label: String = ""
  private var clearToken = 0
  private var reportedHeight = 0f
  private val onChangeText by EventDispatcher()
  private val onContentHeight by EventDispatcher()
  private val density = resources.displayMetrics.density

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
        onChangeText(mapOf("text" to (text?.toString() ?: "")))
        field.post { reportHeight() }
      }
    })
    addView(field, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setEditable(editable: Boolean) {
    field.isEnabled = editable
  }

  /** Clears the field only if it still holds the text that was sent, so text typed meanwhile stays. */
  fun clearIf(text: String, token: Int) {
    if (token == clearToken) return
    clearToken = token
    if (field.text.toString() == text) field.setText("")
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    if (width != oldWidth) post { reportHeight() }
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
