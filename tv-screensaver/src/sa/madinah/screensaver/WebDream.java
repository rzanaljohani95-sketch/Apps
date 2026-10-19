package sa.madinah.screensaver;

import android.graphics.Color;
import android.service.dreams.DreamService;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * شاشة توقف تعرض صفحة الويب بملء الشاشة داخل WebView.
 * يُنشأ الـ WebView عند بدء الشاشة ويُدمَّر عند انتهائها حتى لا يبقى في الذاكرة.
 */
public class WebDream extends DreamService {

    static final String URL = "https://claude.ai/artifact/PVavjjgpPHPDnxtvmPSRCc";

    private WebView web;

    @Override
    public void onAttachedToWindow() {
        super.onAttachedToWindow();
        setInteractive(false);   // أي ضغطة على الريموت تُنهي شاشة التوقف
        setFullscreen(true);
        setScreenBright(true);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient());   // التنقّل يبقى داخل الـ WebView
        setContentView(web);
    }

    @Override
    public void onDreamingStarted() {
        super.onDreamingStarted();
        if (web != null) {
            web.onResume();
            web.loadUrl(URL);
        }
    }

    @Override
    public void onDreamingStopped() {
        if (web != null) web.onPause();
        super.onDreamingStopped();
    }

    @Override
    public void onDetachedFromWindow() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDetachedFromWindow();
    }
}
