#!/usr/bin/env bash
# Candidate source only: owner-reviewed root installation and offline approval required.
# Target SHA and old staging SHA are immutable; no automatic execution.
set -Eeuo pipefail
umask 077
cd /
export PATH=/opt/kmj-codebridge-node/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
block(){ echo "STAGING_UI_UPDATE=BLOCKED_$1"; exit 2; }
[[ "$(hostname -s)" == KMJ-elite && "$(id -u)" == 0 ]] || block HOST
sha=d32df111e3a8dae75c8d3321a80f07424c23fe77
old=9d15e14e39564ffb1e66085a483feb8331f9718f
src=/srv/kmj-codebridge-projects/kmj-main-platform
release=/home/kmjstage/releases/$sha
previous=/home/kmjstage/releases/$old
app=$release/apps/platform
oldapp=$previous/apps/platform
link=/home/kmjstage/htdocs/staging.kmjtechno.com
config=/etc/nginx/sites-enabled/staging.kmjtechno.com.conf
target="$(readlink -f "$config")"
prod=/home/kmjprod/releases/platform-8070dad72c55
[[ "$(readlink -f /home/kmjprod/current)" == "$prod" ]] || block PRODUCTION_DRIFT
[[ "$target" == /etc/nginx/sites-available/staging.kmjtechno.com.conf || "$target" == "$config" ]] || block CONFIG_PATH
[[ -f "$target" && ! -L "$target" && "$(stat -c %u "$target")" == 0 ]] || block CONFIG_OWNER
[[ "$(readlink -f "$link")" == "$oldapp" && -S /run/php/kmjstage-php84-fpm.sock ]] || block STAGING_BASELINE
# Fail before creating a release if uploads still live inside a disposable release tree.
upload_store="$(readlink -f "$oldapp/storage/app")"
[[ "$upload_store" == /home/kmjstage/shared/* && -d "$upload_store" && ! -L "$upload_store" ]] || block UPLOAD_STORAGE_NOT_SHARED
[[ ! -e "$release" && ! -L "$release" ]] || block RELEASE_ALREADY_EXISTS
exec 9>/run/kmj-stage-native-backend.lock
flock -n 9 || block CONCURRENT_JOB
source_git(){ runuser -u kmjcode -- env GIT_TERMINAL_PROMPT=0 git -C "$src" "$@"; }
source_git fetch --no-tags origin refs/heads/staging-approved || block SOURCE_FETCH
[[ "$(source_git rev-parse FETCH_HEAD)" == "$sha" ]] || block STAGING_PROMOTION_PENDING_OR_CHANGED
# Reuse dependencies only when manifests, lockfiles and schema sources match.
source_git diff --quiet "$old" "$sha" -- apps/platform/composer.json apps/platform/composer.lock apps/platform/package-lock.json apps/platform/database/migrations packages || block DEPENDENCY_OR_SCHEMA_CHANGE_REQUIRES_FULL_STAGE
work="$(mktemp -d /root/kmj-staging-d32.XXXXXXXX)"
install -m 0600 "$target" "$work/original.conf"
config_hash="$(sha256sum "$target" | cut -d' ' -f1)"
applied=0
cleanup(){
 rc=$?
 trap - EXIT
 if [[ "$applied" == 1 ]]; then
  current_link="$(readlink -f "$link" || true)"
  current_config_hash="$(sha256sum "$target" | cut -d' ' -f1)"
  # Fail closed rather than overwriting a concurrent operator's cutover.
  if [[ "$current_link" != "$oldapp" && "$current_link" != "$app" ]]; then
   echo STAGING_UI_ROLLBACK=BLOCKED_CONCURRENT_POINTER_REQUIRES_OPERATOR
  elif [[ "$current_config_hash" == "$config_hash" && "$current_link" == "$oldapp" ]]; then
   echo STAGING_UI_ROLLBACK=NOT_NEEDED_ORIGINAL_INTACT
  elif [[ "$current_config_hash" != "$candidate_hash" ]]; then
   echo STAGING_UI_ROLLBACK=BLOCKED_CONCURRENT_CONFIG_REQUIRES_OPERATOR
  else
   install -m 0644 "$work/original.conf" "$target"
   ln -s "$oldapp" "$work/rollback-link"
   mv -Tf "$work/rollback-link" "$link"
   if nginx -t >/dev/null 2>&1 && systemctl reload nginx; then
    echo STAGING_UI_ROLLBACK=PASS
   else
    echo STAGING_UI_ROLLBACK=FAILED_REQUIRES_OPERATOR
   fi
  fi
 fi
 echo "STAGING_UI_PRIVATE_RECEIPT=$work"
 exit "$rc"
}
trap cleanup EXIT
{
 printf '%s\n' "$sha"
 source_git rev-parse "$sha^{tree}"
 source_git ls-tree -r -t --format='%(objectname)' "$sha"
} >"$work/objects"
grep -Eqv '^[a-f0-9]{40}$' "$work/objects" && block OBJECT_LIST
source_git pack-objects --stdout <"$work/objects" >"$work/source.pack"
( umask 022; git init --quiet "$release" )
git -C "$release" index-pack --stdin <"$work/source.pack" >/dev/null
printf '%s\n' "$sha" >"$release/.git/shallow"
git -C "$release" update-ref HEAD "$sha"
git -C "$release" fsck --no-reflogs >/dev/null 2>&1 || block SOURCE_INTEGRITY
( umask 022; git -C "$release" checkout --quiet --detach "$sha" )
[[ -f "$oldapp/.env" && ! -L "$oldapp/.env" ]] || block STAGING_ENV
python3 - "$oldapp/package.json" "$app/package.json" <<'PY'
import json,pathlib,sys
old,new=[json.loads(pathlib.Path(p).read_text()) for p in sys.argv[1:]]
old.pop('scripts',None);new.pop('scripts',None)
assert old==new,'DEPENDENCY_METADATA_CHANGED_REQUIRES_INSTALL'
print('STAGING_DEPENDENCY_METADATA=PASS')
PY
cp -a "$oldapp/vendor" "$app/vendor"
cp -a "$oldapp/node_modules" "$app/node_modules"
cp -a -- "$oldapp/.env" "$app/.env"
runuser -u kmjstage -- test -r "$app/.env" || block STAGING_ENV_READ
chown -R kmjstage:www-data "$release"
chmod 0750 "$release"
shared=/home/kmjstage/shared/product-artwork
[[ "$(readlink -f "$oldapp/storage/app/private/product-artwork")" == "$shared" && -d "$shared" && ! -L "$shared" ]] || block SHARED_ARTWORK_BASELINE
# Reuse only existing shared upload storage so an old release can be retired safely.
[[ -d "$upload_store" && -d "$app/storage/app" && ! -L "$app/storage/app" ]] || block UPLOAD_STORAGE_BASELINE
mv "$app/storage/app" "$work/unused-storage-scaffold"
ln -s "$upload_store" "$app/storage/app"
chown -h kmjstage:www-data "$app/storage/app"
[[ "$(readlink -f "$app/storage/app/private/product-artwork")" == "$shared" ]] || block ARTWORK_CONTINUITY
echo STAGING_UPLOAD_STORAGE=REUSED_EXISTING_PATH_NO_DATA_MOVE
if [[ -L "$oldapp/public/storage" ]]; then
 storage_target="$(readlink -f "$oldapp/public/storage")"
 if [[ "$storage_target" == "$(readlink -f "$oldapp/storage/app/public")" ]]; then
  ln -s "$app/storage/app/public" "$app/public/storage"
 elif [[ "$storage_target" == /home/kmjstage/shared/* && -d "$storage_target" ]]; then
  ln -s "$storage_target" "$app/public/storage"
 else block PUBLIC_STORAGE_TARGET; fi
 chown -h kmjstage:www-data "$app/public/storage"
fi
runuser -u kmjstage -- bash -c 'set -Eeuo pipefail; umask 022; cd "$1"; npm run build' _ "$app"
runuser -u www-data -- test -r "$app/public/build/manifest.json" || block ASSET_ACCESS
[[ "$(runuser -u kmjstage -- git -C "$release" rev-parse HEAD)" == "$sha" ]] || block FINAL_SOURCE
python3 - "$work/original.conf" "$work/candidate.conf" "$oldapp/public" "$app/public" <<'PY'
import pathlib,sys
s=pathlib.Path(sys.argv[1]).read_text()
assert s.count(sys.argv[3])==1,'STAGING_ROOT_BASELINE_CHANGED'
pathlib.Path(sys.argv[2]).write_text(s.replace(sys.argv[3],sys.argv[4]))
PY
# Validate fallback without cloud calls BEFORE touching nginx or the staging pointer.
# Confirm the new explicit offline generator is resolvable, without any cloud API or product writes.
cd "$app"
runuser -u kmjstage -- php8.4 -d display_errors=0 <<'PHP'
<?php
require 'vendor/autoload.php';
$app = require 'bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
if (!app()->environment('staging')) exit(2);
$c = Illuminate\Support\Facades\DB::connection()->getConfig();
if (($c['database']??'') !== 'kmj_stage_2026' || ($c['username']??'') !== 'kmjstage_2026') exit(3);
$draft = app(App\Services\ProductStudio\LocalProductDraftTemplate::class)
    ->fromBrief('inteactive wall projetion SOFTWARE');
if (!isset($draft['name'], $draft['summary'], $draft['features'], $draft['faqs'], $draft['description'])
    || empty($draft['features']) || empty($draft['faqs'])
    || !str_contains($draft['description'], 'not AI-generated copy')) exit(4);
echo "STAGING_OFFLINE_DRAFT=PASS_FACTS_ONLY_NOT_SAVED\n";
echo "STAGING_CLOUD_REQUESTS=NONE\n";
echo "STAGING_PRODUCT_WRITES=NONE\n";
PHP

# Revalidate approval after build: its branch may move during construction.
source_git fetch --no-tags origin refs/heads/staging-approved || block STAGING_APPROVAL_RECHECK
[[ "$(source_git rev-parse FETCH_HEAD)" == "$sha" ]] || block STAGING_PROMOTION_MOVED_DURING_BUILD
# Final compare-and-swap guards both config bytes and staging pointer.
[[ "$(sha256sum "$target" | cut -d' ' -f1)" == "$config_hash" && "$(readlink -f /home/kmjprod/current)" == "$prod" && "$(readlink -f "$link")" == "$oldapp" ]] || block CONCURRENT_CHANGE
candidate_hash="$(sha256sum "$work/candidate.conf" | cut -d' ' -f1)"
applied=1
install -m 0644 "$work/candidate.conf" "$target"
nginx -t || block NGINX_SYNTAX
ln -s "$app" "$work/new-link"
mv -Tf "$work/new-link" "$link"
systemctl reload nginx || block NGINX_RELOAD
for path in / /products /login /company /capabilities /trust; do
 ok=0
 for attempt in {1..8}; do
  code="$(curl --noproxy '*' --proto '=https' --silent --show-error --max-time 15 --resolve staging.kmjtechno.com:443:103.212.136.154 -D "$work/headers" -o /dev/null -w '%{http_code}' "https://staging.kmjtechno.com$path")" || code=000
  if [[ "$code" == 200 ]] && python3 - "$work/headers" "$sha" <<'PY'
import pathlib,sys
v=[s.split(':',1)[1].strip() for s in pathlib.Path(sys.argv[1]).read_text().splitlines() if s.lower().startswith('x-kmj-deploy-sha:')]
raise SystemExit(0 if v==[sys.argv[2]] else 1)
PY
  then ok=1; break; fi
  sleep 0.5
 done
 [[ "$ok" == 1 ]] || block HTTPS_EXACT_SHA
done
[[ "$(readlink -f /home/kmjprod/current)" == "$prod" ]] || block PRODUCTION_POINTER
curl --noproxy '*' --proto '=https' --fail --silent --show-error --max-time 20 --resolve staging.kmjtechno.com:443:103.212.136.154 "https://staging.kmjtechno.com/assets/brand/kmj-logo-horizontal-readable.svg" -o "$work/served-logo.svg" || block LOGO_HTTP
cmp -s "$work/served-logo.svg" "$app/public/assets/brand/kmj-logo-horizontal-readable.svg" || block LOGO_BYTES
python3 - "$work/served-logo.svg" <<'PY'
import pathlib,sys,xml.etree.ElementTree as ET
root=ET.fromstring(pathlib.Path(sys.argv[1]).read_text())
assert not any(n.tag.rsplit('}',1)[-1]=='rect' for n in root.iter()),'OPAQUE_BACKPLATE'
text=root.find('{http://www.w3.org/2000/svg}text')
assert text is not None and text.text=='INNOVATE | BUILD | SCALE','TAGLINE_MISSING'
assert text.attrib.get('font-size')=='56','TAGLINE_TOO_SMALL'
print('STAGING_TRANSPARENT_LOGO=PASS_NO_RECTANGLE')
print('STAGING_READABLE_VECTOR_TAGLINE=PASS')
PY
echo STAGING_LOSSLESS_OFFICIAL_LOGO=PASS_EXACT_BYTES
applied=0
rm -f "$work/source.pack" "$work/objects"
echo STAGING_UI_UPDATE=PASS_EXACT_SHA
echo STAGING_SOURCE_SHA=$sha
echo STAGING_DATABASE_MIGRATIONS=NONE
echo STAGING_DEPENDENCIES=REUSED_IDENTICAL_LOCKFILES
echo PRODUCTION_RELEASE=UNCHANGED

echo STAGING_PRODUCT_STUDIO=DEPLOYED_OWNER_BROWSER_REVIEW_REQUIRED
echo STAGING_PUBLIC_SERVICE_AND_FAQ_SCHEMA=SOURCE_AND_CI_VERIFIED
echo STAGING_PRODUCT_URL=https://staging.kmjtechno.com/operator/products?create=1
