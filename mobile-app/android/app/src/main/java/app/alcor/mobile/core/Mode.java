package app.alcor.mobile.core;

import android.content.Context;

public enum Mode {
    WORK("work", "工作"), LIFE("life", "生活");

    public final String key;
    public final String title;
    Mode(String key, String title) { this.key = key; this.title = title; }

    public static Mode parse(String value) {
        return switch (value) {
            case "work" -> WORK;
            case "life" -> LIFE;
            default -> throw new IllegalArgumentException("模式无效");
        };
    }

    public static Mode active(Context context) { return read(context, "active"); }
    public static Mode ofDialog(String id) {
        return "home:life".equals(id) || id.startsWith("life:discussion:") ? LIFE : WORK;
    }
    public static Mode lastCapture(Context context) { return read(context, "lastCapture"); }
    public void select(Context context) { write(context, "active"); }
    public void rememberCapture(Context context) {
        context.getSharedPreferences("modes", Context.MODE_PRIVATE).edit().putString("lastCapture", key).apply();
    }

    private static Mode read(Context context, String setting) {
        return parse(context.getSharedPreferences("modes", Context.MODE_PRIVATE).getString(setting, WORK.key));
    }

    private void write(Context context, String setting) {
        if (!context.getSharedPreferences("modes", Context.MODE_PRIVATE).edit().putString(setting, key).commit())
            throw new IllegalStateException("无法保存模式，请检查手机存储空间");
    }
}
