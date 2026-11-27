package app.alcor.mobile.core.net;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** One SSE payload from a Chat Completions stream. Pure Java so the frame grammar is testable on the JVM. */
public final class ChatSse {
    private final String content;
    private final String title;
    private final String reasoning;
    private final JSONArray toolCalls;
    private final String error;
    private final JSONObject usage;
    private final boolean done;

    private ChatSse(String content, String title, String reasoning, JSONArray toolCalls, String error,
            JSONObject usage, boolean done) {
        this.content = content;
        this.title = title;
        this.reasoning = reasoning;
        this.toolCalls = toolCalls;
        this.error = error;
        this.usage = usage;
        this.done = done;
    }

    public static ChatSse parse(String data) throws JSONException {
        if (data == null || data.trim().isEmpty()) throw new JSONException("空的数据帧");
        if ("[DONE]".equals(data.trim())) return new ChatSse(null, null, null, null, null, null, true);
        JSONObject frame = new JSONObject(data);
        if (frame.has("error") && !frame.isNull("error")) {
            JSONObject detail = frame.optJSONObject("error");
            String message = detail == null ? frame.optString("error") : detail.optString("message", "模型返回错误");
            return new ChatSse(null, null, null, null, message.isEmpty() ? "模型返回错误" : message, null, false);
        }
        JSONObject usage = frame.optJSONObject("usage");
        String content = null, title = null, reasoning = null;
        JSONArray calls = null;
        var choices = frame.optJSONArray("choices");
        if (choices != null && choices.length() > 0) {
            JSONObject choice = choices.optJSONObject(0);
            JSONObject delta = choice == null ? null : choice.optJSONObject("delta");
            if (delta != null) {
                if (delta.has("content") && !delta.isNull("content")) content = delta.optString("content");
                if (delta.has("title") && !delta.isNull("title")) title = delta.optString("title");
                if (delta.has("reasoning_content") && !delta.isNull("reasoning_content"))
                    reasoning = delta.optString("reasoning_content");
                if (delta.has("tool_calls") && !delta.isNull("tool_calls")) calls = delta.optJSONArray("tool_calls");
            }
        }
        return new ChatSse(content, title, reasoning, calls, null, usage, false);
    }

    public String content() {
        return content;
    }

    public String title() {
        return title;
    }

    public String reasoning() {
        return reasoning;
    }

    public JSONArray toolCalls() {
        return toolCalls;
    }

    public String error() {
        return error;
    }

    public JSONObject usage() {
        return usage;
    }

    public boolean done() {
        return done;
    }
}
