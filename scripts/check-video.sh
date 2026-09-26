#!/usr/bin/env bash
#
# Splat360 Studio — quick check of a source video before importing it.
#
# Prints an ffprobe summary and verifies what the engine's probe stage will
# verify: not a raw Insta360 file, one video stream, 2:1 equirectangular
# frame, sensible resolution, frame rate and duration.
#
# Usage: scripts/check-video.sh <video.mp4> [more videos...]
# Exit status: 0 when every file passes, 1 when any file has an error.
#
set -euo pipefail

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit "$([[ $# -lt 1 ]] && echo 2 || echo 0)"
fi

if [[ -t 1 ]]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_RESET=""
fi
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
err()  { printf '  %s✗ %s%s\n' "$C_RED" "$*" "$C_RESET"; }

# Same thresholds as engine/splat360/pipeline/probe.py
MIN_WIDTH=3840
IDEAL_WIDTH=7680
MIN_DURATION=5
MAX_DURATION=300

FFPROBE="$(command -v ffprobe || true)"
[[ -z "$FFPROBE" && -x /opt/homebrew/bin/ffprobe ]] && FFPROBE=/opt/homebrew/bin/ffprobe
if [[ -z "$FFPROBE" ]]; then
  err "ffprobe not found. Install ffmpeg: brew install ffmpeg"
  exit 1
fi

check_one() {
  local f="$1" errors=0
  printf '%s%s%s\n' "$C_BOLD" "$f" "$C_RESET"
  if [[ ! -f "$f" ]]; then err "file not found"; return 1; fi

  local ext="${f##*.}"; ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  if [[ "$ext" == "insv" || "$ext" == "insp" ]]; then
    err "raw Insta360 file (unstitched dual fisheye)."
    echo "    Open it in Insta360 Studio and export as an equirectangular MP4 (8K, H.265 or H.264,"
    echo "    FlowState stabilization on, Direction Lock off), then check the exported file."
    return 1
  fi
  case "$ext" in
    mp4 | mov | m4v | mkv | webm | avi | mxf) ;;
    *) err "unsupported file type '.$ext' (use MP4 or MOV from Insta360 Studio)"; return 1 ;;
  esac

  # One line per key=value; pick the largest video stream (exports may carry a thumbnail stream).
  local probe
  if ! probe="$("$FFPROBE" -v error -select_streams v -show_entries \
      stream=index,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,nb_frames,pix_fmt,bit_rate \
      -show_entries format=duration,size,bit_rate -of flat "$f" 2>&1)"; then
    err "ffprobe failed: $probe"
    return 1
  fi

  local best=-1 best_px=0 i w h px
  for i in $(printf '%s\n' "$probe" | sed -n 's/^streams\.stream\.\([0-9]*\)\.index=.*/\1/p'); do
    w="$(printf '%s\n' "$probe" | sed -n "s/^streams\.stream\.$i\.width=//p")"
    h="$(printf '%s\n' "$probe" | sed -n "s/^streams\.stream\.$i\.height=//p")"
    px=$(( ${w:-0} * ${h:-0} ))
    if [[ $px -gt $best_px ]]; then best=$i; best_px=$px; fi
  done
  if [[ $best -lt 0 ]]; then err "no video stream found"; return 1; fi

  get() { printf '%s\n' "$probe" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -n 1; }
  local codec fps_raw fps dur nb pix br size
  codec="$(get "streams.stream.$best.codec_name")"
  w="$(get "streams.stream.$best.width")"
  h="$(get "streams.stream.$best.height")"
  fps_raw="$(get "streams.stream.$best.avg_frame_rate")"
  [[ -z "$fps_raw" || "$fps_raw" == "0/0" ]] && fps_raw="$(get "streams.stream.$best.r_frame_rate")"
  fps="$(awk -v r="$fps_raw" 'BEGIN { split(r, a, "/"); if (a[2] > 0) printf "%.3f", a[1] / a[2]; else printf "0" }')"
  dur="$(get "streams.stream.$best.duration")"
  [[ -z "$dur" || "$dur" == "N/A" ]] && dur="$(get "format.duration")"
  nb="$(get "streams.stream.$best.nb_frames")"
  pix="$(get "streams.stream.$best.pix_fmt")"
  br="$(get "streams.stream.$best.bit_rate")"
  [[ -z "$br" || "$br" == "N/A" ]] && br="$(get "format.bit_rate")"
  size="$(get "format.size")"

  printf '  %-12s %s\n' "codec" "${codec:-?} (${pix:-?})"
  printf '  %-12s %sx%s\n' "resolution" "${w:-?}" "${h:-?}"
  printf '  %-12s %s fps (%s)\n' "frame rate" "$fps" "$fps_raw"
  printf '  %-12s %s s%s\n' "duration" "$(awk -v d="${dur:-0}" 'BEGIN { printf "%.1f", d }')" "${nb:+, $nb frames}"
  if [[ -n "$br" && "$br" != "N/A" ]]; then printf '  %-12s %s Mbit/s\n' "bit rate" "$(awk -v b="$br" 'BEGIN { printf "%.0f", b / 1e6 }')"; fi
  if [[ -n "$size" ]]; then printf '  %-12s %s MB\n' "size" "$(awk -v s="$size" 'BEGIN { printf "%.0f", s / 1e6 }')"; fi
  echo

  # --- projection ---------------------------------------------------------
  local ratio
  ratio="$(awk -v w="${w:-0}" -v h="${h:-0}" 'BEGIN { if (h > 0) printf "%.4f", w / h; else printf "0" }')"
  if awk -v r="$ratio" 'BEGIN { exit !(r > 1.98 && r < 2.02) }'; then
    ok "2:1 equirectangular frame (aspect $ratio)"
    if [[ ${w:-0} -lt $MIN_WIDTH ]]; then
      warn "${w}x${h} is below 4K; reconstruction detail will suffer. Export at 8K (7680x3840)."
    elif [[ ${w:-0} -lt $IDEAL_WIDTH ]]; then
      warn "${w}x${h}; an 8K export (7680x3840) gives more detail."
    else
      ok "8K resolution"
    fi
  elif awk -v r="$ratio" -v w="${w:-0}" 'BEGIN { exit !(r > 0.95 && r < 1.05 && w >= 2000) }'; then
    err "${w}x${h} looks like an unstitched dual-fisheye export. Export as equirectangular (2:1) instead."
    errors=1
  else
    err "${w}x${h} is not a 2:1 equirectangular frame (aspect $ratio). Export a 360° equirectangular video, e.g. 7680x3840."
    errors=1
  fi

  # --- frame rate / duration ----------------------------------------------
  if awk -v f="$fps" 'BEGIN { exit !(f > 0 && f < 24) }'; then
    warn "$fps fps is low; keep camera moves slow."
  else
    ok "$fps fps"
  fi
  if [[ -n "$dur" && "$dur" != "N/A" ]]; then
    if awk -v d="$dur" -v m="$MIN_DURATION" 'BEGIN { exit !(d < m) }'; then
      err "clip is ${dur} s; need at least ${MIN_DURATION} s."
      errors=1
    elif awk -v d="$dur" -v m="$MAX_DURATION" 'BEGIN { exit !(d > m) }'; then
      warn "clip is ${dur} s; trim to the useful part (Settings > Keyframes) to keep processing time reasonable."
    else
      ok "duration ${dur} s"
    fi
  fi
  case "${codec:-}" in
    hevc | h264 | prores | av1 | vp9 | mpeg4 | "") ;;
    *) warn "unusual codec '$codec'" ;;
  esac
  if [[ "${pix:-}" == *10* ]]; then warn "10-bit source; frames are converted to 8-bit (fine)."; fi

  echo
  if [[ $errors -eq 0 ]]; then
    ok "ready to import"
  else
    err "the engine will reject this file"
  fi
  return $errors
}

STATUS=0
for f in "$@"; do
  check_one "$f" || STATUS=1
  echo
done
exit $STATUS
