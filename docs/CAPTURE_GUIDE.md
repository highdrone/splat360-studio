# Capture guide

How to shoot a clip that reconstructs well. The pipeline is forgiving about
most things except three: motion blur, a walk that never closes on itself,
and tags that are printed at the wrong size or seen from too far away.

## 1. Print the tags

Generate a sheet from the app (*File > Print AprilTags*, Cmd-P) or the CLI:

```sh
splat360 tags sheet -o tags.pdf --count 12 --size-mm 130 --page letter
```

The size is the edge of the black square. It has to fit the page together
with the white quiet zone the detector needs, so the largest sizes are:

| Paper | Largest tag36h11 (portrait, 10 mm margin) |
| --- | --- |
| Letter | 130 mm |
| A4 | 126 mm |
| Tabloid (11×17) | 172 mm |
| A3 | 184 mm |
| A2 | 266 mm |
| A1 | 382 mm |

Choose the size from the room, not the printer: the black square must span
about 30 px in a 1 600 px pinhole view to be decoded reliably. With the
default 100° views (focal length ≈ 671 px) that gives a **maximum viewing
distance of about 22 × the tag size**: 130 mm → 2.9 m, 200 mm → 4.5 m,
300 mm → 6.7 m. Space tags at roughly 0.6 × that distance so several are
always in range. Small rooms work with 130 mm from a home printer; larger
rooms, halls, garages and outdoor yards want 200–300 mm from a print shop
(`--page a2` or `a1`). The tag planner in the app (`POST /api/tags/plan`)
does this arithmetic from floor area, walk length, ceiling height and your
printer's largest edge.

Printing:

- Print at **100 % / actual size**, never "fit to page". Check the 100 mm
  scale bar on the sheet with a ruler; the reported scale residual after
  reconstruction will show any error you miss here.
- Matte paper. Glossy paper and laminate produce specular highlights that
  blank out the tag from some angles.
- Mount each tag flat on card or foam board. A curled sheet is a curved
  tag and biases the scale.
- Keep the white border; do not trim into the quiet zone.
- Note the size you printed. You will enter it in the project settings, and
  the sheet footer prints it on every tag.

## 2. Place the tags

- **6–12 tags**, `tag36h11`, ids 0–11 from the sheet. More is fine; two is not
  enough (the scale is averaged over every tag seen in three or more views).
- **Mostly on the floor**, flat, spread over the whole area you will walk
  through, 1.5–3 m apart. The floor tags define the ground plane and gravity,
  so put at least four on the floor. A few more on walls or furniture between
  0.3 m and 1.8 m height help scale the upper part of the room (set placement
  to *mixed* in that case).
- Every tag should be visible from several points along your path. A tag in
  a corner you pass once contributes little.
- Keep them out of the nadir cone: the 30° cone straight below the camera is
  masked (it contains the stick and your hand), so a tag you are standing
  next to is not seen until you step away. This is normal.
- Do not put two tags with the same id in the scene.
- Wall tags (*Settings > Tags > placement: wall / mixed*) still give scale but
  not levelling unless floor tags are present as well.

## 3. Camera settings (Insta360 X6)

| Setting | Value |
| --- | --- |
| Mode | 360° video |
| Resolution / frame rate | **8K30** (7680×3840). 5.7K60 is acceptable; higher frame rate does not help |
| Stabilization | FlowState **on**; Direction Lock **off** (lock makes the yaw drift relative to the world) |
| Exposure | Auto is fine indoors; lock it (AE lock) if you move between very bright and dark areas |
| Shutter | As fast as light allows; below 1/60 s expect motion blur. Add light rather than raising ISO |
| ISO | ≤ 800 when possible; noise costs features |
| Colour / HDR | Standard profile, HDR video off, Active HDR off |
| Lens guards | Remove them; they add ghosting and a slight distortion the pinhole model does not expect |
| Mount | Invisible selfie stick, extended so the camera is 1.6–2.0 m above the floor. No handheld: the hand occludes half the sphere |

Firmware bundled 360 stabilisation is what makes this pipeline work with
fixed intrinsics, so leave FlowState on.

## 4. Walk the scene

- **Slow.** About 0.5 m/s (one step per second). Frames are scored for
  sharpness and the blurriest are discarded, but a fast walk leaves nothing
  sharp to choose from.
- **Close the loop.** Start and end at the same spot, facing the same way.
  The loop-closure pairs in SfM (every 10th keyframe against every other 10th)
  need genuine revisits to remove drift.
- **Cover the volume.** In a room: one loop around the perimeter, then a
  figure-eight through the middle. Get within 1–2 m of everything that
  matters; a splat is only as detailed as the closest view.
- **Keep the camera up** and level. Do not swing the stick; the stabiliser
  handles rotation but height changes are wasted motion.
- **Duration 20–60 s.** A 30 s 8K30 clip yields 900 frames from which 200
  keyframes are picked. Longer walks are accepted (up to 5 minutes) but take
  proportionally longer; trim in *Settings > Keyframes* instead.
- Avoid stopping: the keyframe selector spreads keyframes over time, so a
  long pause wastes keyframes on identical views.
- Avoid moving people, mirrors, large windows with a bright exterior, and
  blank white walls where possible. Textureless surfaces do not register.
- Light: even, bright, no flicker. If you must use a lamp, put it behind the
  path, not in it.

Outdoors: same rules; bigger tags; shoot in overcast light or shade. Direct
sun creates hard shadows that move with the clouds and burn out tags.

## 5. Export from Insta360 Studio

The camera writes `.insv` files (two fisheye images side by side). The app
rejects them; export first:

1. Open the clip in Insta360 Studio (desktop).
2. Leave the view untouched (no reframing, no keyframes).
3. Export → **360 video** (equirectangular), resolution **8K** (7680×3840),
   H.265 (smaller) or H.264 (faster to decode), bitrate high, 30 fps.
4. FlowState stabilization **on**, Direction Lock **off**, Horizon lock on if
   available.
5. Save as MP4.

Check the file before importing:

```sh
scripts/check-video.sh ~/Movies/room.mp4
```

It prints codec, resolution, frame rate and duration and flags anything the
engine's probe stage would reject: raw `.insv`, dual-fisheye (square frame),
non-2:1 aspect, less than 5 s.

## 6. In the app

1. *New project*, pick the exported MP4 (or drag it in), choose a preset.
2. *Settings > Tags*: family `tag36h11`, **size in mm as printed**, placement
   *floor*. Optionally restrict to the ids you printed.
3. Run. Watch the *Tags* tab after the tag stage: every printed id should have
   observations in several views. If coverage is poor, stop and re-shoot
   rather than wait for training.
4. After SfM check the registration rate (≥ 90 % is good, < 60 % fails the
   job) and the scale residual after alignment (≤ 1 % is a good print and a
   good reconstruction).

## Checklist

- [ ] Tags printed at 100 %, scale bar verified, matte, flat
- [ ] 6–12 tags on the floor, spread out, each visible from several spots
- [ ] 8K30, FlowState on, Direction Lock off, HDR off, lens guards off
- [ ] Stick extended, camera at 1.6–2 m
- [ ] Slow loop that returns to the start, 20–60 s
- [ ] Exported from Insta360 Studio as equirectangular MP4
- [ ] `scripts/check-video.sh` says "ready to import"
- [ ] Project settings have the printed tag size
