package app.alcor.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class SecretStore {
    private static final String ALIAS = "alcor.mobile.credentials";
    private final SharedPreferences prefs;

    SecretStore(Context context) {
        prefs = context.getSharedPreferences("credentials", Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.getKey(ALIAS, null) instanceof SecretKey key) return key;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    synchronized JSONObject read(String name) throws Exception {
        String value = prefs.getString(name, null);
        if (value == null) return new JSONObject();
        byte[] raw = Base64.decode(value, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOf(raw, 12)));
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(cipher.doFinal(raw, 12, raw.length - 12), StandardCharsets.UTF_8));
    }

    synchronized void write(String name, JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        byte[] raw = Arrays.copyOf(cipher.getIV(), 12 + encrypted.length);
        System.arraycopy(encrypted, 0, raw, 12, encrypted.length);
        if (!prefs.edit().putString(name, Base64.encodeToString(raw, Base64.NO_WRAP)).commit())
            throw new GeneralSecurityException("无法保存凭据");
    }
}
