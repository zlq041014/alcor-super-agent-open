package app.alcor.mobile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** A packet estimate, not a tokenizer or a claim about an undeclared gateway limit. */
final class ContextBudget {
    private static final int UNKNOWN_INPUT = 2048, UNKNOWN_OUTPUT = 512, MIN_OUTPUT = 256;
    record Limits(int window, int input, int output, boolean official) {
        JSONObject describe(double charsPerToken) throws JSONException {
            return new JSONObject().put("window", window).put("input", input).put("output", output)
                .put("charsPerToken", charsPerToken).put("known", window > 0 || input > 0);
        }
    }
    record Packet(int inputChars, int outputTokens, boolean enforceOutput) {}

    private static int limit(JSONObject row, String key) {
        Object value = row.opt(key);
        return value instanceof Number n && n.longValue() >= 256 && n.longValue() <= 10_000_000 && n.doubleValue() == n.longValue()
            ? n.intValue() : 0;
    }
    private static int smaller(int a, int b) { return a == 0 ? b : b == 0 ? a : Math.min(a, b); }

    static Limits limits(JSONObject model, JSONObject row) {
        boolean official = Network.usesOfficialModel(model);
        boolean known = official && model.optString("model").matches("deepseek-flash|deepseek-v4-pro");
        return new Limits(smaller(known ? 1_000_000 : 0, smaller(limit(row, "context_length"), limit(row, "context_window"))), limit(row, "max_input_tokens"),
            smaller(known ? 384_000 : 0, limit(row, "max_output_tokens")), official);
    }

    static Packet plan(Limits limits, int inputChars, int imageCount, double charsPerToken, String kind) {
        int target = switch (kind) { case "summary" -> 1200; case "long" -> 2600; default -> 720; };
        if (limits.window == 0 && limits.input == 0) target = Math.min(target, UNKNOWN_OUTPUT);
        if (limits.output > 0) target = Math.min(target, limits.output);
        if (imageCount > 0 && !limits.official) throw new IllegalArgumentException("模型未确认能读图片或文档，请选择可读的模型或改用文字材料");
        long estimated = (long)Math.ceil(inputChars / charsPerToken) + (long)imageCount * 4096;
        long margin = Math.max(128L, (long)Math.ceil(estimated * 0.15));
        long used = estimated + margin;
        int input = limits.input > 0 ? limits.input : limits.window > 0 ? limits.window : UNKNOWN_INPUT;
        if (limits.window > 0) target = (int)Math.max(0, Math.min(target, limits.window - used));
        if (used > input || target < MIN_OUTPUT)
            throw new InputIssue("input-budget", "本轮必需材料放不下，请减少所选材料或换一个模型", null);
        return new Packet(inputChars, target, limits.official);
    }

    static Packet packet(Limits limits, JSONArray messages, JSONArray tools, double ratio, String kind) throws JSONException {
        int chars = 20 + (tools == null ? 0 : tools.toString().length()), images = 0;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.getJSONObject(i);
            JSONArray parts = message.optJSONArray("content");
            if (parts == null) { chars += message.toString().length() + 8; continue; }
            chars += 42;
            for (int j = 0; j < parts.length(); j++) {
                JSONObject part = parts.getJSONObject(j);
                String type = part.getString("type");
                if ("image_url".equals(type) || "file".equals(type)) images++;
                else chars += part.toString().length();
            }
        }
        return plan(limits, chars, images, ratio, kind);
    }

    static double sample(double previous, int chars, JSONObject usage) {
        int count = usage == null ? 0 : usage.optInt("prompt_tokens", 0);
        return count > 0 && chars >= 64 ? Math.max(0.65, Math.min(2.0, previous * 0.65 + ((double)chars / count) * 0.35)) : previous;
    }
}
