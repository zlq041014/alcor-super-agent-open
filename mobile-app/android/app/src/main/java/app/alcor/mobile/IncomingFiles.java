package app.alcor.mobile;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Process;
import app.alcor.mobile.core.Mode;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** A receipt remains until the WebView has durably attached it to the discussion. */
final class IncomingFiles {
    private final Context context;
    private final File inbox;
    private final DiscussionFiles files;
    IncomingFiles(Context context, DiscussionFiles files) {
        this.context = context.getApplicationContext();
        this.inbox = new File(context.getFilesDir(), "incoming-receipts");
        this.files = files;
    }
    static boolean accepts(Intent i) {
        return i != null && (Intent.ACTION_VIEW.equals(i.getAction()) || Intent.ACTION_SEND.equals(i.getAction()) ||
            Intent.ACTION_SEND_MULTIPLE.equals(i.getAction()));
    }
    @SuppressWarnings("deprecation")
    private List<Uri> grantedUris(Intent intent) {
        LinkedHashSet<Uri> uris = new LinkedHashSet<>();
        if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            if (intent.getData() != null) uris.add(intent.getData());
        } else {
            ClipData clip = intent.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
            Object extra = intent.getExtras() == null ? null : intent.getExtras().get(Intent.EXTRA_STREAM);
            if (extra instanceof Uri uri) uris.add(uri);
            if (extra instanceof ArrayList<?> list) for (Object item : list) {
                if (!(item instanceof Uri uri)) throw new IllegalArgumentException("来源应用没有提供有效的文件");
                uris.add(uri);
            }
        }
        if (uris.isEmpty()) throw new IllegalArgumentException("没有收到文件。请先在来源应用下载文件，再选「用其他应用打开」");
        if (uris.size() > 3) throw new IllegalArgumentException("一次最多接收 3 份文件，请分批打开");
        for (Uri u : uris) {
            if (!"content".equals(u.getScheme()) || u.getAuthority() == null ||
                u.getAuthority().replaceFirst("^[0-9]+@", "").equals(context.getPackageName() + ".materials") ||
                context.checkUriPermission(u, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    != PackageManager.PERMISSION_GRANTED) throw new SecurityException("没有获得文件读取授权");
        }
        return new ArrayList<>(uris);
    }
    void receive(Intent intent, String dialog, Mode mode) throws Exception {
        String id = UUID.randomUUID().toString().replace("-", "");
        JSONObject receipt;
        try { receipt = files.importUris(context, id, dialog, grantedUris(intent)); }
        catch (SecurityException | java.io.FileNotFoundException e) {
            receipt = new JSONObject().put("id", id).put("error", "文件不可读：可能未下载、已过期或来源未授权，请回来源应用重新下载后打开。");
        } catch (IllegalArgumentException | IllegalStateException e) {
            // Only show our own selection limits; provider exceptions may contain private paths.
            String msg = e.getMessage();
            if (msg == null || !msg.matches("^(一次最多|单份手机文件|所选文件超过|没有收到文件|来源应用没有提供|文件尚未接收完整).*"))
                msg = "来源应用未提供可接收的文件。";
            receipt = new JSONObject().put("id", id).put("error", msg);
        } catch (java.io.IOException e) {
            receipt = new JSONObject().put("id", id).put("error", "本机副本未保存。请检查手机空间并重新打开来源文件。");
        }
        byte[] bytes = receipt.put("mode", mode.key).toString().getBytes(StandardCharsets.UTF_8);
        synchronized (IncomingFiles.class) {
            Files.createDirectories(inbox.toPath());
            DiscussionFiles.store(new File(inbox, id + ".json"), new java.io.ByteArrayInputStream(bytes), bytes.length);
        }
    }
    JSONArray pending(Mode mode) throws Exception {
        synchronized (IncomingFiles.class) {
            JSONArray result = new JSONArray();
            if (!inbox.exists()) return result;
            File[] receipts = inbox.listFiles((dir, name) -> name.endsWith(".json"));
            if (receipts == null) throw new java.io.IOException("无法读取收件记录");
            Arrays.sort(receipts, Comparator.comparingLong(File::lastModified));
            for (File f : receipts) {
                JSONObject receipt = read(f);
                if (!belongs(receipt, mode)) continue;
                if (receipt.has("error")) result.put(receipt);
                else {
                    String id = receipt.getString("id");
                    try { result.put(files.manifest(files.directory(id))); }
                    catch (java.nio.file.NoSuchFileException e) {
                        result.put(new JSONObject().put("id", id).put("error", "本机收件副本已不存在，请重新接收。"));
                    }
                }
            }
            return result;
        }
    }
    private File receiptFile(String id) {
        return new File(inbox, DiscussionFiles.id(id) + ".json");
    }
    private static JSONObject read(File file) throws Exception {
        return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }
    private static boolean belongs(JSONObject receipt, Mode mode) {
        return mode.key.equals(receipt.optString("mode", Mode.WORK.key));
    }
    private static void requireMode(File file, Mode mode) throws Exception {
        if (!file.isFile() || !belongs(read(file), mode)) throw new IllegalStateException("本模式没有这批待归入文件");
    }
    JSONObject bind(Mode mode, String id, String dialog) throws Exception {
        synchronized (IncomingFiles.class) {
            requireMode(receiptFile(id), mode);
            if (Mode.ofDialog(dialog) != mode) throw new IllegalArgumentException("不能跨模式归入文件");
            return files.bind(id, dialog);
        }
    }
    void discard(Mode mode, String id) throws Exception {
        synchronized (IncomingFiles.class) {
            File receipt = receiptFile(id);
            if (!receipt.isFile()) return;
            requireMode(receipt, mode);
            File dir = files.directory(id);
            if (dir.exists() && !files.manifest(dir).getString("dialog").isEmpty())
                throw new IllegalStateException("这批文件已归入讨论，可在讨论中移除");
            files.discard(id);
            Files.delete(receipt.toPath());
        }
    }
    void ack(Mode mode, String id) throws Exception {
        synchronized (IncomingFiles.class) {
            File receipt = receiptFile(id);
            if (receipt.isFile()) {
                requireMode(receipt, mode);
                Files.delete(receipt.toPath());
            }
        }
    }
}
