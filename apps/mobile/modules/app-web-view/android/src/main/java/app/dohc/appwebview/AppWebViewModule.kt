package app.dohc.appwebview

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayInputStream
import java.net.URLEncoder

class AppWebViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppWebView")
    View(AppWebView::class) {
      Events("onOpenLink", "onEnd")
      Prop("bootstrap") { view: AppWebView, value: String -> view.bootstrap = value }
      Prop("handoff") { view: AppWebView, value: String -> view.handoff = value }
      OnViewDidUpdateProps { view: AppWebView -> view.start() }
      OnViewDestroys { view: AppWebView -> view.end() }
    }
  }
}

/** A workspace app on Android. It decides here, at once, and refuses by default. What it refuses, and what the app
 * frame's sandbox and the server's policies hold instead: docs/engineering/security-boundaries.md. */
@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
class AppWebView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  var bootstrap = ""
  var handoff = ""
  private val onOpenLink by EventDispatcher()
  private val onEnd by EventDispatcher()
  private val main = Handler(Looper.getMainLooper())
  private var web: WebView? = null
  private var catcher: WebView? = null
  private var started = false

  init {
    val view = WebView(context)
    view.settings.apply {
      javaScriptEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      setGeolocationEnabled(false)
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      cacheMode = WebSettings.LOAD_NO_CACHE
      useWideViewPort = true
      loadWithOverviewMode = true
      mediaPlaybackRequiresUserGesture = true
      setSupportMultipleWindows(true)
      javaScriptCanOpenWindowsAutomatically = false
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
    view.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

      // Android ends dohc itself when a renderer dies and this returns false. The app ends instead.
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        end()
        onEnd(mapOf<String, Any>())
        return true
      }
    }
    view.webChromeClient = object : WebChromeClient() {
      override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
        val transport = resultMsg.obj as? WebView.WebViewTransport
        if (!isUserGesture || transport == null) return false
        transport.webView = catcher()
        resultMsg.sendToTarget()
        return true
      }

      override fun onPermissionRequest(request: PermissionRequest) = request.deny()

      override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
        callback.invoke(origin, false, false)
    }
    addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    web = view
  }

  /** Loads the bootstrap once both props are set. A later render never sends the one-use handoff again. */
  fun start() {
    val view = web ?: return
    if (started || !bootstrap.startsWith("https://") || handoff.isEmpty()) return
    started = true
    view.postUrl(bootstrap, "handoff=${URLEncoder.encode(handoff, "UTF-8")}".toByteArray())
  }

  /** Ends the app once, when React removes the view or its renderer is gone. */
  fun end() {
    drop()
    val view = web ?: return
    web = null
    view.stopLoading()
    removeView(view)
    view.destroy()
  }

  /** The window a tap opened: a hidden view that answers every request empty, reports the first address it's sent to,
   * and is gone after that or after a second. One at a time. */
  private fun catcher(): WebView {
    drop()
    val view = WebView(context)
    view.settings.apply {
      javaScriptEnabled = false
      allowFileAccess = false
      allowContentAccess = false
    }
    view.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
        WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (view === catcher) {
          onOpenLink(mapOf("url" to request.url.toString()))
          drop()
        }
        return true
      }

      // It shares the app's renderer; returning false here would end dohc too.
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        if (view === catcher) drop()
        return true
      }
    }
    catcher = view
    main.postDelayed({ if (catcher === view) drop() }, 1_000)
    return view
  }

  private fun drop() {
    val view = catcher ?: return
    catcher = null
    // Not from inside its own callback.
    main.post { view.destroy() }
  }
}
