package app.alcor.mobile;

import android.content.Context;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;

/** Real DeepSeek checks that run only when the caller explicitly passes live=1. Never prints the key. */
final class LiveCheck {
    private static final String TAG = "LiveCheckStage";

    private LiveCheck() {
    }

    private static void mark(String stage) {
        Log.i(TAG, stage);
    }

    private static String shortText(String value, int max) {
        return value.length() > max ? value.substring(0, max) : value;
    }

    private static String trace(Throwable error) {
        var text = new java.io.StringWriter();
        error.printStackTrace(new java.io.PrintWriter(text));
        return shortText(text.toString(), 700);
    }

    private static JSONObject chatWithRetry(JSONObject config, JSONArray messages, JSONArray tools, StringBuilder text)
            throws Exception {
        text.setLength(0);
        try {
            return Network.chat(config, messages, false, tools, text::append);
        } catch (java.net.SocketException | java.io.EOFException transientError) {
            text.setLength(0);
            return Network.chat(config, messages, false, tools, text::append);
        }
    }

    static String run(Context context) throws Exception {
        SecretStore secrets = new SecretStore(context);
        JSONObject config = secrets.read("model");
        if (!config.has("key")) return new JSONObject().put("skipped", "没有配置模型 Key").toString();
        if ("deepseek-chat".equals(config.optString("model"))) config.put("model", "deepseek-flash");
        if (!config.has("effort")) config.put("effort", "high");
        String stage = "chat";
        JSONObject out = new JSONObject().put("model", config.optString("model"))
            .put("endpointHost", java.net.URI.create(config.getString("endpoint")).getHost());
        try {
            mark("chat-start");
            JSONArray messages = new JSONArray().put(new JSONObject().put("role", "user").put("content", "只回复两个字：收到"));
            StringBuilder plain = new StringBuilder();
            JSONObject first = Network.chat(config, messages, true, null, plain::append);
            JSONObject usage = first.optJSONObject("usage");
            if (plain.length() == 0) throw new AssertionError("真实答复为空");
            if (usage == null || usage.optInt("prompt_tokens") <= 0 || usage.optInt("completion_tokens") <= 0)
                throw new AssertionError("真实接口没有返回用量");
            out.put("plainText", shortText(plain.toString(), 80));
            out.put("title", first.optString("title"));
            out.put("usage", usage);

            stage = "reminder";
            java.time.LocalDate today = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai"));
            String[] weekdays = {"星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"};
            String reminder = today + "," + weekdays[today.getDayOfWeek().getValue() - 1] + ",,App,中文";
            JSONArray dateMessages = new JSONArray()
                .put(new JSONObject().put("role", "latest_reminder").put("content", reminder))
                .put(new JSONObject().put("role", "user").put("content", "只回答一行：今天是几月几日、星期几"));
            StringBuilder dateText = new StringBuilder();
            Network.chat(config, dateMessages, false, null, dateText::append);
            if (dateText.length() == 0) throw new AssertionError("带日期提醒的请求没有答复");
            out.put("reminder", reminder).put("reminderAnswer", shortText(dateText.toString(), 80));

            mark("chat-done");
            stage = "search";
            JSONObject search = Network.search(config, secrets.read("search").optString("key"), "DeepSeek API 文档");
            JSONArray items = search.optJSONArray("items");
            if (items == null || items.length() == 0) throw new AssertionError("真实搜索没有结果");
            out.put("searchProvider", search.optString("provider")).put("searchCount", items.length())
                .put("searchFirst", items.getJSONObject(0).optString("title"));

            mark("search-done");
            stage = "fetch";
            JSONObject page = Network.fetch(config, "https://api-docs.deepseek.com/zh-cn/guides/search/");
            String content = page.optString("content");
            if (content.trim().isEmpty()) throw new AssertionError("真实 Fetch 没有正文");
            out.put("fetchTitle", page.optString("title")).put("fetchChars", content.length());

            mark("fetch-done");
            stage = "tool-call";
            JSONObject toolConfig = new JSONObject(config.toString()).put("effort", "low").put("max_tokens", 500);
            JSONArray tools = new JSONArray().put(new JSONObject().put("type", "function").put("function",
                new JSONObject().put("name", "web_search").put("description", "搜索实时网页")
                    .put("parameters", new JSONObject().put("type", "object")
                        .put("properties", new JSONObject().put("query", new JSONObject().put("type", "string")))
                        .put("required", new JSONArray().put("query")))));
            String toolQuestion = "只调用一次 web_search 工具搜索 DeepSeek API 文档，然后用一句话回答，不要连续调用，也不要只凭记忆回答。";
            JSONArray toolMessages = new JSONArray().put(new JSONObject().put("role", "user").put("content", toolQuestion));
            StringBuilder toolText = new StringBuilder();
            mark("tool-chat-start");
            JSONObject turn = Network.chat(toolConfig, toolMessages, false, tools, toolText::append);
            mark("tool-chat-done");
            JSONArray calls = turn.optJSONArray("tool_calls");
            out.put("toolCalled", calls != null && calls.length() > 0);
            if (calls != null && calls.length() > 0) {
                out.put("toolCallCount", calls.length());
                int resultChars = 0;
                toolMessages.put(new JSONObject().put("role", "assistant").put("content", turn.optString("content"))
                    .put("reasoning_content", turn.optString("reasoning")).put("tool_calls", calls));
                for (int i = 0; i < calls.length(); i++) {
                    JSONObject call = calls.getJSONObject(i);
                    JSONObject function = call.getJSONObject("function");
                    JSONObject args = new JSONObject(function.optString("arguments", "{}"));
                    String query = args.optString("query", "DeepSeek API 文档");
                    if (i == 0) out.put("toolName", function.optString("name")).put("toolArgs", args);
                    JSONObject result = Network.search(toolConfig, secrets.read("search").optString("key"), query);
                    JSONArray found = result.optJSONArray("items");
                    JSONArray compact = new JSONArray();
                    for (int j = 0; found != null && j < Math.min(3, found.length()); j++) {
                        JSONObject item = found.getJSONObject(j);
                        compact.put(new JSONObject().put("title", item.optString("title")).put("url", item.optString("url"))
                            .put("summary", shortText(item.optString("summary"), 500)));
                    }
                    String resultContent = new JSONObject().put("results", compact).toString();
                    resultChars += resultContent.length();
                    toolMessages.put(new JSONObject().put("role", "tool").put("tool_call_id", call.getString("id"))
                        .put("content", resultContent));
                }
                out.put("toolResultChars", resultChars);
                mark("tool-results-done");
                StringBuilder finalText = new StringBuilder();
                JSONObject finalTurn = chatWithRetry(toolConfig, toolMessages, tools, finalText);
                mark("final-chat-done");
                if (finalText.length() == 0) throw new AssertionError("工具调用后没有得到最终答复");
                out.put("finalText", shortText(finalText.toString(), 160))
                    .put("toolUsage", finalTurn.optJSONObject("usage"));
            }
            out.put("ok", true);
            return out.toString();
        } catch (Exception error) {
            out.put("ok", false).put("stage", stage).put("error", MobileService.issue(error)).put("detail", trace(error));
            return out.toString();
        }
    }
}
