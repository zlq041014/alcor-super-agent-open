package app.alcor.mobile;

import android.annotation.SuppressLint;
import android.util.Base64;
import app.alcor.mobile.core.net.ChatSse;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONArray;
import org.json.JSONObject;

final class Network {
    interface Delta { void accept(String delta); }

    static URI https(String value) {
        URI url = URI.create(value);
        if (!"https".equals(url.getScheme()) || url.getHost() == null ||
                url.getUserInfo() != null || url.getFragment() != null || url.getQuery() != null)
            throw new IllegalArgumentException("请输入有效的 HTTPS 地址");
        return url;
    }

    @SuppressLint("CustomX509TrustManager") // The user-selected computer's exact certificate replaces CA identity only for pairing.
    private static HttpsURLConnection connect(String endpoint, JSONObject body, String header,
            String secret, String pin, int timeout) throws Exception {
        HttpsURLConnection conn = (HttpsURLConnection) URI.create(endpoint).toURL().openConnection();
        conn.setInstanceFollowRedirects(false);
        conn.setConnectTimeout(4000);
        conn.setReadTimeout(timeout);
        if (pin != null) {
            byte[] expected = Base64.decode(pin, Base64.URL_SAFE | Base64.NO_WRAP);
            if (expected.length != 32) throw new IllegalArgumentException("电脑证书指纹无效");
            X509TrustManager trust = new X509TrustManager() {
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                    throw new CertificateException("不接受客户端证书");
                }
                public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                    if (chain == null || chain.length == 0) throw new CertificateException("电脑未提供证书");
                    chain[0].checkValidity();
                    try {
                        if (MessageDigest.isEqual(expected, MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()))) return;
                    } catch (java.security.NoSuchAlgorithmException error) {
                        throw new CertificateException(error);
                    }
                    throw new CertificateException("电脑证书与配对码不匹配");
                }
            };
            SSLContext tls = SSLContext.getInstance("TLS");
            tls.init(null, new TrustManager[]{trust}, new SecureRandom());
            conn.setSSLSocketFactory(tls.getSocketFactory());
            conn.setHostnameVerifier((hostname, session) -> true); // Exact certificate pin above supplies the identity.
        }
        if (header != null) conn.setRequestProperty(header, secret);
        if (body != null) {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (var output = conn.getOutputStream()) { output.write(bytes); }
            catch (IOException error) { conn.disconnect(); throw error; }
        }
        return conn;
    }

    static HttpsURLConnection bearer(String url, String method, String token) throws Exception {
        HttpsURLConnection c = (HttpsURLConnection) Network.https(url).toURL().openConnection();
        c.setRequestMethod(method);
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(6000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    static JSONObject desktop(JSONObject peer, String route, JSONObject body) throws Exception {
        String endpoint = https(peer.getString("url")).toString();
        HttpsURLConnection conn = connect(endpoint + "/mobile/v1/" + route, body,
                "Authorization", "Bearer " + peer.getString("token"), peer.getString("pin"), 16000);
        try { return desktopResult(peer, conn); }
        finally { conn.disconnect(); }
    }

    static JSONObject material(JSONObject peer, JSONObject info, InputStream input, long size) throws Exception {
        String endpoint = https(peer.getString("url")).toString();
        HttpsURLConnection conn = connect(endpoint + "/mobile/v1/material", null,
                "Authorization", "Bearer " + peer.getString("token"), peer.getString("pin"), 20000);
        try {
            conn.setRequestMethod("PUT");
            conn.setRequestProperty("X-Alcor-Material", Base64.encodeToString(info.toString().getBytes(StandardCharsets.UTF_8),
                Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP));
            conn.setRequestProperty("Content-Type", "application/octet-stream");
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(size);
            try (var output = conn.getOutputStream()) {
                byte[] buffer = new byte[16384];
                for (int n; (n = input.read(buffer)) != -1;) output.write(buffer, 0, n);
            }
            return desktopResult(peer, conn);
        } finally { conn.disconnect(); }
    }

    private static JSONObject desktopResult(JSONObject peer, HttpsURLConnection conn) throws Exception {
        int code = conn.getResponseCode();
        if (code == 401) return new JSONObject().put("revoked", true);
        if (code != 200) throw new IOException("电脑返回 HTTP " + code);
        JSONObject result = read(conn.getInputStream(), 4 * 1024 * 1024);
        if (!peer.getString("id").equals(result.getString("deviceId")))
            throw new IOException("电脑身份与配对码不匹配");
        return result;
    }

    static JSONObject chatBody(JSONObject config, JSONArray messages) throws Exception {
        return chatBody(config, messages, false, null);
    }

    static JSONObject chatBody(JSONObject config, JSONArray messages, boolean title) throws Exception {
        return chatBody(config, messages, title, null);
    }

    static JSONObject chatBody(JSONObject config, JSONArray messages, boolean title, JSONArray tools) throws Exception {
        String effort = config.getString("effort");
        JSONObject body = new JSONObject().put("model", config.getString("model"))
            .put("thinking", new JSONObject().put("type", "none".equals(effort) ? "disabled" : "enabled"))
            .put("stream", true).put("messages", messages);
        if (!"none".equals(effort)) body.put("reasoning_effort", effort);
        if (config.has("max_tokens")) body.put("max_tokens", config.getInt("max_tokens"));
        // Custom gateways may reject DeepSeek's title extension; only the official endpoint gets it.
        if (title && usesOfficialModel(config)) body.put("title", new JSONObject().put("enabled", true));
        if (tools != null && tools.length() > 0) body.put("tools", tools);
        return body;
    }

    /** Streams the answer and returns the last frame's usage, title, reasoning and tool calls. */
    static JSONObject chat(JSONObject config, JSONArray messages, boolean title, Delta delta) throws Exception {
        return chat(config, messages, title, null, delta);
    }

    static JSONObject chat(JSONObject config, JSONArray messages, boolean title, JSONArray tools, Delta delta) throws Exception {
        JSONObject body = chatBody(config, messages, title, tools);
        HttpsURLConnection conn = connect(config.getString("endpoint"), body,
            "Authorization", "Bearer " + config.getString("key"), null, 90000);
        try {
            int code = conn.getResponseCode();
            if (code != 200) {
                String detail = errorBody(conn);
                String lower = detail.toLowerCase(java.util.Locale.ROOT);
                if (code == 400 && (lower.contains("context") || lower.contains("maximum") || lower.contains("token") ||
                        detail.contains("上下文") || detail.contains("长度")))
                    throw new IOException("DeepSeek 上下文超过模型上限，请压缩后重试");
                if (code == 400) {
                    String safe = detail.replaceAll("\\s+", " ").trim();
                    throw new IOException("DeepSeek 返回 HTTP 400：" +
                        (safe.isEmpty() ? "请求无效" : safe.substring(0, Math.min(300, safe.length()))));
                }
                throw new IOException("DeepSeek 返回 HTTP " + code + "，请检查请求或凭据");
            }
            JSONObject usage = null;
            String answerTitle = "";
            StringBuilder reasoning = new StringBuilder();
            java.util.Map<Integer, JSONObject> calls = new java.util.TreeMap<>();
            try (var reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                int length = 0;
                String line;
                while ((line = reader.readLine()) != null) {
                    if (!line.startsWith("data:")) continue;
                    String data = line.substring(5).trim();
                    ChatSse frame = ChatSse.parse(data);
                    if (frame.error() != null) throw new IOException("DeepSeek 中断了答复：" + frame.error());
                    if (frame.usage() != null) usage = frame.usage();
                    if (frame.title() != null && !frame.title().trim().isEmpty()) answerTitle = frame.title().trim();
                    if (frame.reasoning() != null) reasoning.append(frame.reasoning());
                    JSONArray fragments = frame.toolCalls();
                    for (int i = 0; fragments != null && i < fragments.length(); i++) {
                        JSONObject fragment = fragments.getJSONObject(i);
                        int index = fragment.optInt("index", i);
                        JSONObject call = calls.get(index);
                        if (call == null) {
                            call = new JSONObject().put("type", "function")
                                .put("function", new JSONObject());
                            calls.put(index, call);
                        }
                        if (fragment.has("id")) call.put("id", fragment.getString("id"));
                        JSONObject part = fragment.optJSONObject("function");
                        if (part != null) {
                            JSONObject function = call.getJSONObject("function");
                            if (part.has("name")) function.put("name", part.getString("name"));
                            if (part.has("arguments")) function.put("arguments",
                                function.optString("arguments", "") + part.getString("arguments"));
                        }
                    }
                    if (frame.done()) {
                        if (length == 0 && calls.isEmpty()) throw new IOException("DeepSeek 返回了空答复");
                        JSONObject result = new JSONObject();
                        if (usage != null) result.put("usage", usage);
                        if (!answerTitle.isEmpty()) result.put("title", answerTitle);
                        if (reasoning.length() > 0) result.put("reasoning", reasoning.toString());
                        if (!calls.isEmpty()) {
                            JSONArray ordered = new JSONArray();
                            for (JSONObject call : calls.values()) ordered.put(call);
                            result.put("tool_calls", ordered);
                        }
                        return result;
                    }
                    String text = frame.content();
                    if (text == null || text.isEmpty()) continue;
                    length += text.length();
                    if (length > 80000) throw new IOException("DeepSeek 答复超过保留上限");
                    delta.accept(text);
                }
                throw new IOException("DeepSeek 连接在答复完成前断开");
            }
        } finally { conn.disconnect(); }
    }

    private static String errorBody(HttpsURLConnection conn) {
        try (var input = conn.getErrorStream()) {
            if (input == null) return "";
            byte[] bytes = new byte[16384];
            int size = 0, count;
            while (size < bytes.length && (count = input.read(bytes, size, bytes.length - size)) != -1) size += count;
            return new String(bytes, 0, size, StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            return "";
        }
    }

    static boolean usesOfficialModel(JSONObject config) {
        if (!config.has("key")) return false;
        URI endpoint = https(config.optString("endpoint"));
        return "api.deepseek.com".equalsIgnoreCase(endpoint.getHost()) &&
            (endpoint.getPort() == -1 || endpoint.getPort() == 443) &&
            ("/chat/completions".equals(endpoint.getPath()) || "/v1/chat/completions".equals(endpoint.getPath()));
    }

    static JSONObject search(JSONObject model, String braveKey, String query) throws Exception {
        if (usesOfficialModel(model)) {
            query = query.trim();
            if (query.isEmpty() || query.codePointCount(0, query.length()) > 128)
                throw new IllegalArgumentException("DeepSeek 搜索关键词需为 1 至 128 个字符");
            JSONObject body = new JSONObject().put("query", query).put("count", 5);
            HttpsURLConnection conn = connect("https://api.deepseek.com/v1/tools/search", body,
                "Authorization", "Bearer " + model.getString("key"), null, 16000);
            try {
                int code = conn.getResponseCode();
                if (code != 200) throw new IOException("DeepSeek 搜索返回 HTTP " + code + "，请检查官方 Key 与余额");
                return searchResults("DeepSeek 官方", read(conn.getInputStream(), 1024 * 1024).getJSONArray("results"), "summary");
            } finally { conn.disconnect(); }
        }
        if (braveKey.isEmpty()) throw new IllegalStateException("请先在设置中接入 Brave Search");
        String encoded = java.net.URLEncoder.encode(query, "UTF-8");
        HttpsURLConnection conn = connect("https://api.search.brave.com/res/v1/web/search?count=5&q=" + encoded,
            null, "X-Subscription-Token", braveKey, null, 16000);
        try {
            int code = conn.getResponseCode();
            if (code != 200) throw new IOException("Brave Search 返回 HTTP " + code);
            JSONObject web = read(conn.getInputStream(), 1024 * 1024).optJSONObject("web");
            return searchResults("Brave Search", web == null ? null : web.optJSONArray("results"), "description");
        } finally { conn.disconnect(); }
    }

    static JSONObject fetch(JSONObject model, String value) throws Exception {
        if (!usesOfficialModel(model)) throw new IllegalStateException("读取链接需要 DeepSeek 官方 Key");
        String url = value == null ? "" : value.trim();
        if (url.length() > 8192) throw new IllegalArgumentException("链接过长");
        URI uri = URI.create(url);
        if (!("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme())) ||
                uri.getHost() == null || uri.getUserInfo() != null)
            throw new IllegalArgumentException("请输入有效的网页链接");
        JSONObject body = new JSONObject().put("url", uri.toString());
        HttpsURLConnection conn = connect("https://api.deepseek.com/v1/tools/fetch", body,
            "Authorization", "Bearer " + model.getString("key"), null, 30000);
        try {
            int code = conn.getResponseCode();
            if (code != 200) {
                if (code == 402) throw new IOException("DeepSeek 余额不足，网页没有读取");
                if (code == 403) throw new IOException("网页被安全策略拒绝读取");
                if (code == 404) throw new IOException("网页打不开，或没有可读正文");
                if (code == 429) throw new IOException("读取网页太频繁，请稍后再试");
                throw new IOException("DeepSeek 读取网页返回 HTTP " + code);
            }
            JSONObject page = read(conn.getInputStream(), 2 * 1024 * 1024);
            String content = page.optString("content");
            if (content.trim().isEmpty()) throw new IOException("网页没有可读正文");
            return new JSONObject().put("title", page.optString("title"))
                .put("content", content.length() > 120000 ? content.substring(0, 120000) : content);
        } finally { conn.disconnect(); }
    }

    private static JSONObject searchResults(String provider, JSONArray items, String summaryField) throws Exception {
        JSONArray safe = new JSONArray();
        for (int i = 0; items != null && i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            String url = item.getString("url");
            URI uri;
            try { uri = URI.create(url); }
            catch (IllegalArgumentException invalid) { continue; }
            if (uri.getHost() == null || uri.getUserInfo() != null || !"https".equals(uri.getScheme())) continue;
            safe.put(new JSONObject().put("url", url).put("domain", uri.getHost())
                .put("title", item.getString("title")).put("summary", item.optString(summaryField)));
        }
        return new JSONObject().put("provider", provider).put("items", safe);
    }

    static JSONObject read(InputStream input, int max) throws Exception {
        try (input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] bytes = new byte[8192];
            int count;
            while ((count = input.read(bytes)) != -1) {
                if (output.size() + count > max) throw new IOException("返回内容超过大小上限");
                output.write(bytes, 0, count);
            }
            return new JSONObject(output.toString("UTF-8"));
        }
    }
}
