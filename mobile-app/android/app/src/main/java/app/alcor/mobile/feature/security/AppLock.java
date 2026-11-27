package app.alcor.mobile.feature.security;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import app.alcor.mobile.R;
import java.util.function.Consumer;

/** A per-Activity curtain; only Android's credential result can grant an unlocked session. */
public final class AppLock {
    private static final int VERIFY = 5920;
    private final Activity activity;
    private final SharedPreferences settings;
    private final View protectedView;
    private final FrameLayout curtain;
    private final TextView title, problem;
    private final Button unlock;
    private final Runnable opened;
    private volatile boolean locked;
    private Consumer<String> verifying;
    private CancellationSignal cancellation;

    public AppLock(Activity activity, View protectedView, Runnable opened) {
        this.activity = activity;
        this.protectedView = protectedView;
        this.opened = opened;
        settings = activity.getSharedPreferences("app-lock", Activity.MODE_PRIVATE);
        curtain = new FrameLayout(activity);
        curtain.setClickable(true);
        var column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        int space = Math.round(24 * activity.getResources().getDisplayMetrics().density);
        column.setPadding(space, space, space, space);
        var icon = new ImageView(activity);
        icon.setImageResource(R.mipmap.alcor_icon);
        column.addView(icon, new LinearLayout.LayoutParams(space * 3, space * 3));
        title = new TextView(activity);
        title.setText("已锁定");
        title.setTextSize(24);
        title.setPadding(0, space / 2, 0, space / 2);
        column.addView(title);
        problem = new TextView(activity);
        unlock = new Button(activity);
        unlock.setText("解锁星引");
        unlock.setOnClickListener(view -> authenticate(error -> {
            if (error == null) {
                setLocked(false);
                opened.run();
            } else problem.setText(error);
        }));
        column.addView(unlock);
        problem.setGravity(Gravity.CENTER);
        problem.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        column.addView(problem);
        curtain.addView(column, new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER));
        ((ViewGroup) activity.findViewById(android.R.id.content)).addView(curtain, new ViewGroup.LayoutParams(-1, -1));
        secureWindow();
        setLocked(enabled());
    }

    public boolean enabled() { return settings.getBoolean("enabled", false); }
    public boolean locked() { return locked; }
    public boolean canAuthenticate() { return activity.getSystemService(KeyguardManager.class).isDeviceSecure(); }

    public void setEnabled(boolean enabled, Consumer<String> done) {
        if (locked) { done.accept("请先解锁星引"); return; }
        if (enabled == enabled()) { done.accept(null); return; }
        authenticate(error -> {
            if (error != null) { done.accept(error); return; }
            if (!settings.edit().putBoolean("enabled", enabled).commit()) {
                done.accept("无法保存应用锁设置");
                return;
            }
            secureWindow();
            setLocked(false);
            done.accept(null);
        });
    }

    public void lockNow() {
        if (!enabled()) throw new IllegalStateException("请先开启应用锁");
        setLocked(true);
    }
    public void onStop() {
        if (enabled()) setLocked(true);
    }

    public void destroy() {
        verifying = null;
        if (cancellation != null) cancellation.cancel();
    }

    private void secureWindow() {
        if (enabled()) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    private void setLocked(boolean value) {
        locked = value;
        boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
        curtain.setBackgroundColor(Color.parseColor(dark ? "#1d1935" : "#f6f5fb"));
        title.setTextColor(Color.parseColor(dark ? "#f2f0fc" : "#1b1638"));
        problem.setTextColor(title.getCurrentTextColor());
        problem.setText("");
        protectedView.setVisibility(value ? View.INVISIBLE : View.VISIBLE);
        curtain.setVisibility(value ? View.VISIBLE : View.GONE);
        if (value) {
            activity.getSystemService(android.view.inputmethod.InputMethodManager.class)
                .hideSoftInputFromWindow(protectedView.getWindowToken(), 0);
            unlock.requestFocus();
        }
    }

    @SuppressWarnings("deprecation")
    private void authenticate(Consumer<String> done) {
        if (verifying != null) { done.accept("系统验证正在进行"); return; }
        if (!canAuthenticate()) { done.accept("请先在系统设置启用锁屏密码"); return; }
        verifying = done;
        unlock.setEnabled(false);
        if (Build.VERSION.SDK_INT >= 30) {
            int methods = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
            cancellation = new CancellationSignal();
            try {
                new BiometricPrompt.Builder(activity).setTitle("验证身份").setSubtitle("星引应用锁")
                    .setAllowedAuthenticators(methods).build()
                    .authenticate(cancellation, activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                        @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) { complete(null); }
                        @Override public void onAuthenticationError(int code, CharSequence message) { complete("未通过系统验证"); }
                    });
            } catch (RuntimeException unavailable) { complete("无法打开系统验证"); }
        } else {
            var intent = activity.getSystemService(KeyguardManager.class).createConfirmDeviceCredentialIntent("验证身份", "星引应用锁");
            if (intent == null) { complete("系统验证不可用"); return; }
            try { activity.startActivityForResult(intent, VERIFY); }
            catch (android.content.ActivityNotFoundException unavailable) { complete("无法打开系统验证"); }
        }
    }

    public boolean onActivityResult(int request, int result) {
        if (request != VERIFY) return false;
        complete(result == Activity.RESULT_OK ? null : "未通过系统验证");
        return true;
    }

    private void complete(String error) {
        var callback = verifying;
        verifying = null;
        cancellation = null;
        unlock.setEnabled(true);
        if (callback != null) callback.accept(error);
    }
}
