package app.alcor.mobile;

import android.content.Context;
import android.content.res.Configuration;
import android.util.Base64;
import app.alcor.mobile.feature.reminders.Reminders;
import app.alcor.mobile.feature.work.WorkNotices;
import app.alcor.mobile.core.Mode;
import app.alcor.mobile.feature.memory.Memories;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/** Bridge operations that do not need an Activity. */
public final class MobileService {
    private final Context context;
    private final SecretStore secrets;
    private final ModelTurns modelTurns;
    private final DiscussionFiles materials;
    private final IncomingFiles incoming;
    private final Notes notes;
    private final Reminders reminders;
    private final Memories memories;
    private final WorkNotices workNotices;

    MobileService(AppContainer container) {
        context = container.context();
        secrets = container.secrets();
        modelTurns = container.modelTurns();
        materials = container.materials();
        incoming = container.incoming();
        notes = container.notes();
        reminders = container.reminders();
        memories = container.memories();
        workNotices = container.workNotices();
    }

    public Object execute(String op, JSONObject input, Consumer<String> delta) throws Exception {
        Mode mode = op.startsWith("notes.") || op.startsWith("inbox.") ||
            op.startsWith("reminders.") || op.startsWith("memories.") ? Mode.parse(input.getString("mode")) : null;
        switch (op) {
            case "workNotice.status": return workNotices.enabled();
            case "workNotice.reconcile": return workNotices.reconcile(input.getJSONArray("items"), input.getBoolean("enabled"));
            case "mode.set": Mode.parse(input.getString("mode")).select(context); return true;
            case "memories.list": return memories.list(mode, input.optString("project", ""), input.optInt("offset", 0));
            case "memories.get": return memories.get(mode, input.getString("id"));
            case "memories.add": return memories.add(mode, input.getString("id"), input.getString("text"), input.getString("kind"),
                input.getString("source"), input.getString("sourceRef"), input.optString("project", ""));
            case "memories.update": return memories.update(mode, input.getString("id"), input.getString("text"), input.getBoolean("enabled"));
            case "memories.delete": return memories.delete(mode, input.getString("id"), input.optBoolean("undo"));
            case "memories.confirm": return memories.confirm(mode, input.getString("id"));
            case "memories.context": return memories.context(mode, input.optString("project", ""), input.optString("query", ""));
            case "memories.used": return memories.used(mode, input.getJSONArray("ids"));
            case "reminders.list": return reminders.list(mode, input.getBoolean("history"), input.getInt("offset"));
            case "reminders.get": return reminders.get(mode, input.getString("id"), input.optBoolean("opened"));
            case "reminders.add": {
                String origin = input.getString("origin"), ref = input.getString("ref");
                if ("note".equals(origin)) notes.get(mode, ref);
                if ("chat".equals(origin) && Mode.ofDialog(new JSONArray(ref).getString(0)) != mode)
                    throw new IllegalArgumentException("不能跨模式引用对话");
                return reminders.add(mode, input.getString("id"), input.getString("text"), input.getLong("at"), origin, ref);
            }
            case "reminders.edit": return reminders.edit(mode, input.getString("id"), input.getInt("version"), input.getString("text"), input.getLong("at"));
            case "reminders.cancel": return reminders.cancel(mode, input.getString("id"), input.getInt("version"));
            case "reminders.permissions": return reminders.permissions(mode);
            case "settings": return settings();
            case "model.clear":
                synchronized (modelTurns) {
                    secrets.write("model", new JSONObject());
                    modelTurns.clear();
                }
                return settings();
            case "model.save": {
                String endpoint = Network.https(input.getString("endpoint").trim()).toString();
                String model = input.getString("model").trim();
                String key = input.getString("key").trim();
                if (model.isEmpty() || model.length() > 120) throw new IllegalArgumentException("请填写有效的模型名");
                String effort = input.getString("effort");
                if (!effort.matches("none|low|high|max")) throw new IllegalArgumentException("思考强度无效");
                synchronized (modelTurns) {
                    JSONObject old = secrets.read("model");
                    if (key.isEmpty() && endpoint.equals(old.optString("endpoint"))) key = old.optString("key");
                    verifyKey(key);
                    secrets.write("model", new JSONObject().put("endpoint", endpoint).put("model", model).put("key", key).put("effort", effort));
                    modelTurns.replaceKey(endpoint, key);
                }
                return settings();
            }
            case "search.save": {
                String key = input.getString("key").trim();
                if (!key.isEmpty()) verifyKey(key);
                synchronized (modelTurns) {
                    secrets.write("search", key.isEmpty() ? new JSONObject() : new JSONObject().put("key", key));
                    modelTurns.replaceSearchKey(key);
                }
                return settings();
            }
            case "material.branch": {
                String from = input.getString("dialog"), to = input.getString("to");
                if (Mode.ofDialog(from) != Mode.ofDialog(to)) throw new IllegalArgumentException("不能跨模式移动材料");
                return materials.branch(from, to, input.getJSONArray("refs"));
            }
            case "inbox.pending": return incoming.pending(mode);
            case "inbox.bind": return incoming.bind(mode, input.getString("id"), input.getString("dialog"));
            case "inbox.discard": incoming.discard(mode, input.getString("id")); return true;
            case "inbox.ack": incoming.ack(mode, input.getString("id")); return true;
            case "notes.list":
                return notes.list(mode, input.optString("query", ""), input.optInt("offset", 0), input.optString("box", ""));
            case "notes.get": return notes.get(mode, input.getString("id"));
            case "notes.add": {
                String source = input.optString("source", "app");
                String id = "assistant".equals(source) ? DiscussionFiles.id(input.getString("id")) : Notes.newId();
                notes.addText(mode, id, input.getString("text"), source);
                if ("app".equals(source)) mode.rememberCapture(context);
                return notes.get(mode, id);
            }
            case "notes.undoAdd": notes.undoAssistantAdd(mode, input.getString("id")); return true;
            case "notes.update": {
                JSONObject note = notes.get(mode, input.getString("id"));
                String text = input.has("text") ? input.getString("text") : note.getString("text");
                String project = input.has("project") ? input.getString("project") : note.getString("project");
                String state = input.has("box") ? input.getString("box") : null;
                return notes.update(mode, note.getString("id"), text, project, state);
            }
            case "notes.attach": {
                JSONObject note = notes.get(mode, input.getString("id"));
                String project = input.getString("project");
                return notes.update(mode, note.getString("id"), note.getString("text"), project,
                    project.isEmpty() ? Notes.INBOX : Notes.FILED);
            }
            case "notes.box": return notes.setBox(mode, input.getString("id"), input.getString("box"));
            case "notes.delete": notes.delete(mode, input.getString("id")); return true;
            case "notes.branch": {
                String to = input.getString("to");
                if (Mode.ofDialog(to) != mode) throw new IllegalArgumentException("不能跨模式引用笔记");
                return notes.branch(mode, input.getString("id"), to);
            }
            case "material.remove": materials.remove(input.getString("dialog"), input.getString("ref")); return true;
            case "chat.begin": {
                synchronized (modelTurns) {
                    JSONObject model = modelConfig();
                    return new JSONObject().put("id", modelTurns.begin(model, secrets.read("search").optString("key")))
                        .put("model", model.getString("model")).put("officialSearch", Network.usesOfficialModel(model));
                }
            }
            case "chat.check": modelTurns.require(input.getString("turn")).checkAttachments(); return true;
            case "chat.end": modelTurns.end(input.getString("turn")); return true;
            case "chat": {
                String id = input.optString("turn");
                var turn = input.has("turn") ? modelTurns.require(id) : null;
                JSONObject config = turn == null ? modelConfig() : turn.model();
                JSONArray messages = input.getJSONArray("messages");
                if (turn != null) turn.checkSelection(input.has("files"));
                JSONArray tools = input.optJSONArray("tools");
                if (input.has("files")) {
                    if (turn == null) throw new IllegalArgumentException("附件需要在已绑定的模型回合发送");
                    var limits = modelTurns.limits(id);
                    double ratio = modelTurns.ratio(turn);
                    turn.attach(materials, input.getString("dialog"), input.getJSONArray("files"), messages, () -> {
                        modelTurns.require(id);
                        ContextBudget.packet(limits, messages, tools, ratio, "short");
                    }, () -> modelTurns.require(id), materials::uploadDocument);
                    var packet = ContextBudget.packet(limits, messages, tools, ratio, "short");
                    if (packet.enforceOutput()) config = new JSONObject(config.toString()).put("max_tokens", packet.outputTokens());
                    turn.checkAttachments();
                    modelTurns.require(id);
                }
                return Network.chat(config, messages, input.optBoolean("title"), tools, delta::accept);
            }
            case "search": {
                if (input.has("turn")) {
                    var turn = modelTurns.require(input.getString("turn"));
                    turn.checkAttachments();
                    return Network.search(turn.model(), turn.searchKey(), input.getString("query"));
                }
                return Network.search(secrets.read("model"), secrets.read("search").optString("key"), input.getString("query"));
            }
            case "fetch": {
                if (input.has("turn")) {
                    var turn = modelTurns.require(input.getString("turn"));
                    turn.checkAttachments();
                    return Network.fetch(turn.model(), input.getString("url"));
                }
                return Network.fetch(modelConfig(), input.getString("url"));
            }
            case "pair": {
                String code = PairingCode.require(input.getString("code"));
                JSONObject invite = new JSONObject(new String(Base64.decode(code.substring(7), Base64.URL_SAFE | Base64.NO_WRAP), StandardCharsets.UTF_8));
                URI url = Network.https(invite.getString("url"));
                if (!url.getPath().isEmpty()) throw new IllegalArgumentException("配对地址必须为电脑入口");
                JSONObject accepted = Network.desktop(invite, "pair", new JSONObject());
                if (accepted.optBoolean("revoked")) throw new IllegalArgumentException("配对码已过期或已使用");
                JSONObject peer = accepted.getJSONObject("pair").put("url", url.toString()).put("pin", invite.getString("pin"));
                synchronized (secrets) {
                    JSONObject peers = secrets.read("peers").put(peer.getString("id"), peer);
                    secrets.write("peers", peers);
                }
                return settings();
            }
            case "unpair": {
                synchronized (secrets) {
                    JSONObject peers = secrets.read("peers");
                    peers.remove(input.getString("id"));
                    secrets.write("peers", peers);
                }
                return settings();
            }
            case "desktop.material": {
                if (Mode.ofDialog(input.getString("dialog")) == Mode.LIFE)
                    throw new IllegalArgumentException("生活材料不能发送到电脑");
                JSONObject peer = secrets.read("peers").getJSONObject(input.getString("id"));
                return materials.upload(peer, input.getString("dialog"), input.getString("ref"), input.getJSONObject("info"));
            }
            case "desktop": {
                JSONObject peer = secrets.read("peers").getJSONObject(input.getString("id"));
                String route = input.getString("route");
                if (!route.matches("catalog|agents|resume|decision-evidence|history|pull|push|command|accept|artifact|delivery|reply"))
                    throw new IllegalArgumentException("不支持的电脑操作");
                return Network.desktop(peer, route, input.getJSONObject("body"));
            }
            default: throw new IllegalArgumentException("不支持的手机操作");
        }
    }

    private JSONObject settings() throws Exception {
        JSONObject model = modelConfig();
        JSONObject peers = secrets.read("peers");
        JSONArray paired = new JSONArray();
        var ids = peers.keys();
        while (ids.hasNext()) {
            JSONObject peer = peers.getJSONObject(ids.next());
            paired.put(new JSONObject().put("id", peer.getString("id")).put("grant", peer.getString("grant")).put("name", peer.getString("name")));
        }
        boolean officialSearch = Network.usesOfficialModel(model);
        return new JSONObject().put("ready", model.has("key")).put("endpoint", model.optString("endpoint"))
            .put("phoneInbox", true).put("mode", Mode.active(context).key)
            .put("model", model.getString("model")).put("effort", model.getString("effort")).put("officialSearch", officialSearch)
            .put("search", officialSearch || secrets.read("search").has("key")).put("peers", paired)
            .put("dark", (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
    }

    private JSONObject modelConfig() throws Exception {
        JSONObject config = secrets.read("model");
        if (!config.has("effort")) {
            if (!config.has("model") || (Network.usesOfficialModel(config) && "deepseek-chat".equals(config.optString("model"))))
                config.put("model", "deepseek-flash");
            config.put("effort", "high");
        }
        return config;
    }

    private static void verifyKey(String key) {
        if (!key.matches("[\\x21-\\x7e]{1,4000}")) throw new IllegalArgumentException("请填写有效的 API Key");
    }

    public static Object bridgeIssue(Exception error) {
        return error instanceof InputIssue input ? input.bridgeValue() : issue(error);
    }

    public static String issue(Exception error) {
        if (error instanceof javax.net.ssl.SSLException) return "安全连接未建立，请检查 HTTPS 地址或重新配对";
        if (error instanceof java.net.SocketTimeoutException) return "连接超时，请稍后核对";
        if (error instanceof java.net.UnknownHostException || error instanceof java.net.ConnectException)
            return "暂时无法连接，请检查网络或目标是否在线";
        if (error instanceof org.json.JSONException) return "数据格式不符合当前接口";
        if (error instanceof android.database.sqlite.SQLiteException) return "本地记录无法写入，请检查手机存储";
        if (error instanceof IllegalArgumentException || error instanceof IllegalStateException)
            return error.getMessage() == null ? "设置或状态无效" : error.getMessage();
        if (error instanceof java.io.IOException && error.getMessage() != null &&
                error.getMessage().matches("^(DeepSeek|Brave Search|电脑|返回内容).*")) return error.getMessage();
        return "手机无法完成这项操作，请检查网络、设置或本地存储";
    }
}
