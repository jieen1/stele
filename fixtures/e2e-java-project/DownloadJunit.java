import java.io.*;
import java.net.*;

public class DownloadJunit {
    public static void main(String[] args) throws Exception {
        String[][] urls = {
            {"https://repo1.maven.org/maven2/org/apiguardian/apiguardian-api/1.1.2/apiguardian-api-1.1.2.jar", "apiguardian-api.jar"},
        };
        for (String[] u : urls) {
            URL url = new URL(u[0]);
            String name = u[1];
            System.out.println("Downloading " + name + "...");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("User-Agent", "Java");
            try (InputStream in = conn.getInputStream()) {
                File out = new File("lib/" + name);
                out.getParentFile().mkdirs();
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
                }
            }
            System.out.println("  -> " + name + " done");
        }
        System.out.println("All downloads complete.");
    }
}
