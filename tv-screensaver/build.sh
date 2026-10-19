#!/usr/bin/env bash
# يبني MadinahScreensaver.apk بأدوات JDK فقط (بدون Android Studio أو aapt2):
#   javac -> dx (classes.dex) -> axml.py (manifest ثنائي) -> zip -> توقيع apksig
# الأدوات تُنزَّل مرة واحدة إلى build/tools من Maven Central و GitHub.
set -euo pipefail
cd "$(dirname "$0")"
B=build; T=$B/tools
mkdir -p "$T"

fetch() { [ -s "$T/$1" ] || curl -fsSL -o "$T/$1" "$2"; }
fetch android.jar https://raw.githubusercontent.com/Sable/android-platforms/master/android-30/android.jar
fetch dx.jar      https://repo1.maven.org/maven2/com/jakewharton/android/repackaged/dalvik-dx/16.0.1/dalvik-dx-16.0.1.jar
fetch apksig.jar  https://repo1.maven.org/maven2/com/android/tools/build/apksig/2.3.0/apksig-2.3.0.jar

rm -rf "$B/classes" "$B/apk"; mkdir -p "$B/classes" "$B/apk"
javac -source 8 -target 8 -bootclasspath "$T/android.jar" -nowarn -d "$B/classes" \
  $(find src -name '*.java') 2>&1 | grep -v '^warning: \[options\]' || true
java -cp "$T/dx.jar" com.android.dx.command.Main --dex --min-sdk-version=24 --output="$B/apk/classes.dex" "$B/classes"
python3 tools/axml.py AndroidManifest.xml "$B/apk/AndroidManifest.xml"
(cd "$B/apk" && rm -f ../unsigned.apk && zip -qX ../unsigned.apk AndroidManifest.xml classes.dex)

# مفتاح توقيع محلي ثابت: يجب استخدام نفس المفتاح في كل بناء ليقبل التلفاز التحديث.
KS=${KEYSTORE:-release.p12}
[ -f "$KS" ] || keytool -genkeypair -storetype PKCS12 -keystore "$KS" -storepass android -keypass android \
  -alias screensaver -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Madinah Screensaver" >/dev/null 2>&1
javac -cp "$T/apksig.jar" -d "$B/signer" tools/Sign.java
java --add-exports java.base/sun.security.x509=ALL-UNNAMED -cp "$T/apksig.jar:$B/signer" Sign "$KS" android screensaver "$B/unsigned.apk" MadinahScreensaver.apk
echo "✓ MadinahScreensaver.apk"
