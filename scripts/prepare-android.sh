#!/usr/bin/env bash
# Personalizza il progetto Android generato da Capacitor: icone, colore, permesso fotocamera, versione.
set -euo pipefail
RES=android/app/src/main/res
# icone
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  mkdir -p "$RES/mipmap-$d"
  cp resources/android/mipmap-$d/*.png "$RES/mipmap-$d/"
done
# sfondo dell'icona adattiva
mkdir -p "$RES/values"
cat > "$RES/values/ic_launcher_background.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#D7261E</color>
</resources>
XML
# permesso fotocamera (per fotografare le copertine)
MAN=android/app/src/main/AndroidManifest.xml
if ! grep -q "android.permission.CAMERA" "$MAN"; then
  sed -i 's#<uses-permission android:name="android.permission.INTERNET" />#<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.CAMERA" />#' "$MAN"
fi
# numero di versione = numero della compilazione su GitHub (serve per aggiornare l'app sopra la vecchia)
BUILD=${GITHUB_RUN_NUMBER:-1}
sed -i -E "s/versionCode [0-9]+/versionCode ${BUILD}/; s/versionName \"[^\"]+\"/versionName \"1.1.${BUILD}\"/" android/app/build.gradle
echo "Progetto Android pronto (versione 1.1.${BUILD})"
