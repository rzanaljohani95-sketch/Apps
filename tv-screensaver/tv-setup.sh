#!/usr/bin/env bash
# يثبّت شاشة التوقف على تلفاز Google TV عبر adb ويجعلها الافتراضية بعد 5 دقائق خمول،
# أو يُرجع الإعدادات الأصلية من ملف النسخة الاحتياطية.
#
#   ./tv-setup.sh install <IP[:PORT]>
#   ./tv-setup.sh restore <IP[:PORT]> <ملف-النسخة-الاحتياطية>
#
# - كل أمر يغيّر شيئاً على التلفاز يُعرض أولاً ولا يُنفّذ إلا بعد موافقتك (y).
# - لا يعطّل ولا يحذف أي تطبيق نظام. الحذف الوحيد الممكن هو تطبيقنا نفسه عند الإرجاع وبموافقتك.
set -euo pipefail
cd "$(dirname "$0")"

PKG=sa.madinah.screensaver
COMPONENT=$PKG/$PKG.WebDream
APK=MadinahScreensaver.apk
# الإعدادات التي قد نغيّرها: namespace:key
KEYS="secure:screensaver_enabled secure:screensaver_components secure:screensaver_activate_on_sleep system:screen_off_timeout"

usage() { sed -n '4,6p' "$0"; exit 1; }
[ $# -ge 2 ] || usage
MODE=$1; TARGET=$2
case "$TARGET" in *:*) ;; *) TARGET=$TARGET:5555 ;; esac
command -v adb >/dev/null || { echo "adb غير مثبّت. ثبّت Android platform-tools أولاً."; exit 1; }

A() { adb -s "$TARGET" "$@"; }

# يعرض الأمر ثم ينفّذه فقط عند الموافقة
confirm_run() {
  echo
  echo "  الأمر:  adb -s $TARGET $*"
  read -r -p "  تنفيذ؟ [y/N] " ans <"${CONFIRM_FROM:-/dev/tty}" || ans=
  if [ "$ans" = y ] || [ "$ans" = Y ]; then A "$@"; echo "  ✓ تم"; else echo "  ⏭ تم التخطي"; fi
}

get() { A shell settings get "${1%%:*}" "${1#*:}" | tr -d '\r'; }

echo "الاتصال بالتلفاز $TARGET ..."
adb connect "$TARGET" | tr -d '\r'
if ! A get-state >/dev/null 2>&1; then
  # المنفذ 5555 لم ينجح: ابحث عن منفذ "تصحيح الأخطاء اللاسلكي" الذي يعلنه التلفاز عبر mDNS
  IP=${TARGET%%:*}
  PORT=$(adb mdns services 2>/dev/null | tr -d '\r' | grep '_adb-tls-connect' | grep -o "$IP:[0-9]*" | head -1 | cut -d: -f2 || true)
  if [ -z "$PORT" ]; then
    echo
    echo "لم يُعثر على منفذ تصحيح الأخطاء اللاسلكي تلقائياً."
    echo "افتح على التلفاز: الإعدادات ← النظام ← خيارات المطوّر ← تصحيح الأخطاء اللاسلكي، واكتب المنفذ الظاهر بجانب عنوان IP"
    read -r -p "  المنفذ (أو Enter للإلغاء): " PORT <"${CONFIRM_FROM:-/dev/tty}" || PORT=
  fi
  if [ -n "$PORT" ]; then
    TARGET=$IP:$PORT
    echo "المحاولة على $TARGET ..."
    adb connect "$TARGET" | tr -d '\r'
    if ! A get-state >/dev/null 2>&1; then
      echo
      echo "يلزم الاقتران أولاً: في نفس الشاشة على التلفاز اختر \"إقران الجهاز باستخدام رمز\"."
      read -r -p "  منفذ الاقتران الظاهر (غير منفذ الاتصال): " PPORT <"${CONFIRM_FROM:-/dev/tty}" || PPORT=
      [ -n "$PPORT" ] && adb pair "$IP:$PPORT" </dev/tty && adb connect "$TARGET" | tr -d '\r'
    fi
  fi
fi
if ! A get-state >/dev/null 2>&1; then
  cat <<MSG
تعذّر الاتصال. تأكد من:
  - أن التلفاز والكمبيوتر على نفس الشبكة، وأن "تصحيح الأخطاء عبر USB/الشبكة" مفعّل في خيارات المطوّر.
  - إن ظهرت على التلفاز رسالة "السماح بتصحيح الأخطاء؟" فاختر "السماح".
  - في الأجهزة الأحدث (تصحيح الأخطاء اللاسلكي): نفّذ  adb pair IP:PORT  بالرمز الظاهر على التلفاز
    ثم أعد تشغيل هذا السكربت بالمنفذ الظاهر في شاشة "تصحيح الأخطاء اللاسلكي".
MSG
  exit 1
fi
echo "متصل: $(A shell getprop ro.product.manufacturer | tr -d '\r') $(A shell getprop ro.product.model | tr -d '\r') — Android $(A shell getprop ro.build.version.release | tr -d '\r')"

if [ "$MODE" = install ]; then
  BACKUP="tv-settings-backup-$(date +%Y%m%d-%H%M%S).txt"
  {
    echo "# الإعدادات الأصلية قبل التعديل — $(date)"
    echo "# للإرجاع: ./tv-setup.sh restore $TARGET $BACKUP"
    for k in $KEYS; do echo "$k=$(get "$k")"; done
    echo "package_installed_before=$(A shell pm list packages "$PKG" | grep -qx "package:$PKG" && echo yes || echo no)"
  } > "$BACKUP"
  echo
  echo "الإعدادات الأصلية (محفوظة في $BACKUP):"
  grep -v '^#' "$BACKUP" | sed 's/^/  /'

  [ -f "$APK" ] || { echo "لم أجد $APK — شغّل ./build.sh أولاً."; exit 1; }
  echo; echo "1) تثبيت التطبيق (أو تحديثه إن كان مثبّتاً):"
  confirm_run install -r "$APK"
  echo; echo "2) جعل شاشة المدينة المنورة هي شاشة التوقف:"
  confirm_run shell settings put secure screensaver_components "$COMPONENT"
  echo; echo "3) تفعيل شاشة التوقف:"
  confirm_run shell settings put secure screensaver_enabled 1
  echo; echo "4) تشغيلها عند انتهاء مدة الخمول:"
  confirm_run shell settings put secure screensaver_activate_on_sleep 1
  echo; echo "5) مدة الخمول قبل ظهورها: 5 دقائق (300000 ملّي ثانية):"
  confirm_run shell settings put system screen_off_timeout 300000

  echo; echo "القيم الآن:"
  for k in $KEYS; do echo "  $k=$(get "$k")"; done
  echo
  echo "للإرجاع لاحقاً:  ./tv-setup.sh restore $TARGET $BACKUP"

elif [ "$MODE" = restore ]; then
  BACKUP=${3:-}; [ -f "$BACKUP" ] || usage
  echo; echo "إرجاع الإعدادات من $BACKUP:"
  for k in $KEYS; do
    orig=$(grep "^$k=" "$BACKUP" | cut -d= -f2-) || continue
    now=$(get "$k")
    [ "$orig" = "$now" ] && { echo "  $k بقيمته الأصلية ($orig) — لا تغيير"; continue; }
    ns=${k%%:*}; key=${k#*:}
    echo; echo "$k: الحالي=$now ← الأصلي=$orig"
    if [ "$orig" = null ]; then confirm_run shell settings delete "$ns" "$key"
    else confirm_run shell settings put "$ns" "$key" "$orig"; fi
  done
  if grep -q '^package_installed_before=no' "$BACKUP"; then
    echo; echo "إزالة تطبيق شاشة المدينة المنورة (تطبيقنا فقط، وليس تطبيق نظام):"
    confirm_run uninstall "$PKG"
  fi
else
  usage
fi
