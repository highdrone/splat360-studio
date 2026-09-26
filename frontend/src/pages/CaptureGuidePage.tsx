import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/ui';

function Section({ id, title, children, figure }: { id: string; title: string; children: ReactNode; figure?: ReactNode }) {
  return (
    <section id={id} className="panel p-5 scroll-mt-4" aria-labelledby={`${id}-h`}>
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5">
        <div className="min-w-0">
          <h2 id={`${id}-h`} className="text-base font-semibold mb-2">
            {title}
          </h2>
          <div className="text-[13px] leading-6 text-ink space-y-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:text-ink [&_code]:code">{children}</div>
        </div>
        {figure && <div className="xl:pt-1">{figure}</div>}
      </div>
    </section>
  );
}

function Figure({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="rounded-md border border-line bg-panel2 p-3">
      <div className="[&_svg]:w-full [&_svg]:h-auto">{children}</div>
      <figcaption className="mt-2 text-2xs text-muted leading-4">{caption}</figcaption>
    </figure>
  );
}

const S = { stroke: 'rgb(var(--c-muted))', muted: 'rgb(var(--c-muted))', ink: 'rgb(var(--c-ink))', accent: 'rgb(var(--c-accent))', ok: 'rgb(var(--c-ok))', warn: 'rgb(var(--c-warn))', danger: 'rgb(var(--c-danger))', faint: 'rgb(var(--c-faint))' };

function StickFigure() {
  return (
    <svg viewBox="0 0 300 200" role="img" aria-label="Operator holding an invisible selfie stick with the camera at 1.6 metres">
      <line x1="20" y1="180" x2="280" y2="180" stroke={S.stroke} strokeWidth="1.5" />
      <g stroke={S.ink} strokeWidth="2" fill="none" strokeLinecap="round">
        <circle cx="110" cy="70" r="10" />
        <line x1="110" y1="80" x2="110" y2="130" />
        <line x1="110" y1="130" x2="95" y2="178" />
        <line x1="110" y1="130" x2="125" y2="178" />
        <line x1="110" y1="95" x2="140" y2="85" />
        <line x1="140" y1="85" x2="170" y2="70" />
      </g>
      <line x1="170" y1="70" x2="190" y2="30" stroke={S.faint} strokeWidth="2" strokeDasharray="4 4" />
      <circle cx="190" cy="26" r="9" fill={S.accent} />
      <circle cx="190" cy="26" r="3" fill="#fff" />
      <g stroke={S.ok} strokeWidth="1.5">
        <line x1="240" y1="26" x2="240" y2="180" />
        <line x1="234" y1="26" x2="246" y2="26" />
        <line x1="234" y1="180" x2="246" y2="180" />
      </g>
      <text x="248" y="106" fontSize="11" fill={S.ok}>
        ≈1.6 m
      </text>
      <text x="20" y="196" fontSize="10" fill={S.faint}>
        camera above and away from the body, stick hidden in the nadir
      </text>
    </svg>
  );
}

function LoopsFigure() {
  return (
    <svg viewBox="0 0 300 200" role="img" aria-label="Floor plan with two overlapping loops of camera path and tags on floor and walls">
      <rect x="20" y="20" width="260" height="160" fill="none" stroke={S.stroke} strokeWidth="2" />
      <rect x="150" y="20" width="4" height="70" fill={S.stroke} />
      <path d="M50 60 C 60 30, 130 30, 135 60 S 110 150, 60 150 S 30 90, 50 60 Z" fill="none" stroke={S.accent} strokeWidth="2" strokeDasharray="5 3" />
      <path d="M170 60 C 180 30, 250 30, 255 60 S 230 150, 180 150 S 150 90, 170 60 Z" fill="none" stroke={S.accent} strokeWidth="2" strokeDasharray="5 3" />
      <path d="M60 100 C 100 60, 200 60, 250 100 C 200 140, 100 140, 60 100 Z" fill="none" stroke={S.ok} strokeWidth="1.5" />
      {[
        [40, 40], [130, 165], [265, 40], [210, 165], [95, 100], [200, 100], [150, 120], [40, 165],
      ].map(([x, y], i) => (
        <rect key={i} x={x - 5} y={y - 5} width="10" height="10" fill={S.ink} />
      ))}
      {[[70, 24], [230, 176], [24, 120], [276, 80]].map(([x, y], i) => (
        <rect key={`w${i}`} x={x - 5} y={y - 3} width="10" height="6" fill={S.warn} />
      ))}
      <text x="24" y="196" fontSize="10" fill={S.faint}>
        dashed: room loops · solid: connecting loop · squares: tags (floor black, wall amber)
      </text>
    </svg>
  );
}

function SpeedFigure() {
  return (
    <svg viewBox="0 0 300 120" role="img" aria-label="Walking at 0.5 metres per second, a 30 second clip covers about 15 metres">
      <line x1="20" y1="70" x2="280" y2="70" stroke={S.stroke} strokeWidth="2" />
      {Array.from({ length: 16 }).map((_, i) => (
        <line key={i} x1={20 + i * (260 / 15)} y1="64" x2={20 + i * (260 / 15)} y2="76" stroke={S.faint} strokeWidth="1" />
      ))}
      {Array.from({ length: 31 }).map((_, i) => (
        <circle key={i} cx={20 + i * (260 / 30)} cy="70" r="2.2" fill={S.accent} />
      ))}
      <text x="20" y="56" fontSize="10" fill={S.muted}>
        0 m
      </text>
      <text x="255" y="56" fontSize="10" fill={S.muted}>
        15 m
      </text>
      <text x="90" y="100" fontSize="11" fill={S.ink}>
        30 s at ≈0.5 m/s → one frame every 0.5 m
      </text>
    </svg>
  );
}

function LevelFigure() {
  return (
    <svg viewBox="0 0 300 130" role="img" aria-label="Keep the camera level: avoid tilting it up or down">
      <g>
        <circle cx="70" cy="55" r="20" fill="none" stroke={S.ok} strokeWidth="2" />
        <line x1="40" y1="55" x2="100" y2="55" stroke={S.ok} strokeWidth="2" />
        <text x="45" y="105" fontSize="11" fill={S.ok}>
          level
        </text>
      </g>
      <g transform="rotate(-25 220 55)">
        <circle cx="220" cy="55" r="20" fill="none" stroke={S.danger} strokeWidth="2" />
        <line x1="190" y1="55" x2="250" y2="55" stroke={S.danger} strokeWidth="2" />
      </g>
      <text x="190" y="105" fontSize="11" fill={S.danger}>
        tilted
      </text>
      <text x="120" y="125" fontSize="10" fill={S.faint}>
        equator of the sphere stays horizontal
      </text>
    </svg>
  );
}

function ExportFigure() {
  return (
    <svg viewBox="0 0 300 150" role="img" aria-label="Export settings in Insta360 Studio">
      <rect x="10" y="10" width="280" height="130" rx="6" fill="none" stroke={S.stroke} strokeWidth="1.5" />
      <text x="22" y="32" fontSize="11" fontWeight="600" fill={S.ink}>
        Export → Video
      </text>
      {[
        ['Projection', '360° (equirectangular)'],
        ['Resolution', '8K · 7680 × 3840'],
        ['Codec', 'H.265 (or H.264)'],
        ['FlowState', 'on'],
        ['Direction Lock', 'off'],
      ].map(([k, v], i) => (
        <g key={k} transform={`translate(22 ${50 + i * 18})`}>
          <text fontSize="10.5" fill={S.muted}>
            {k}
          </text>
          <text x="120" fontSize="10.5" fill={i === 4 ? S.warn : S.ok} fontWeight="600">
            {v}
          </text>
        </g>
      ))}
    </svg>
  );
}

const TOC = [
  ['camera', 'Camera settings'],
  ['rig', 'Rig and height'],
  ['path', 'Walking the scene'],
  ['avoid', 'What to avoid'],
  ['tags', 'AprilTags'],
  ['export', 'Export from Insta360 Studio'],
  ['failures', 'Common failure modes'],
];

export function CaptureGuidePage() {
  return (
    <div>
      <PageHeader title="Capture guide" subtitle="How to shoot with an Insta360 X6 so the reconstruction is sharp, complete and metric." />
      <nav className="mb-4 flex flex-wrap gap-1 text-xs" aria-label="On this page">
        {TOC.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="chip hover:text-ink">
            {label}
          </a>
        ))}
        <Link to="/tags" className="chip ml-auto text-accent">
          Print tags →
        </Link>
      </nav>
      <div className="space-y-4">
        <Section id="camera" title="Camera settings" figure={<Figure caption="Everything that changes between frames hurts: exposure, white balance and HDR tone-mapping all make the same wall look different from two positions."><LevelFigure /></Figure>}>
          <ul>
            <li>
              <strong>8K at 30 fps</strong> (7680 × 3840). Higher frame rate does not help; resolution does, because each keyframe is cut into six or ten pinhole views.
            </li>
            <li>
              <strong>Lock exposure and white balance.</strong> Use manual mode: pick an ISO and shutter that expose the darkest part of the route, then leave them. Auto exposure creates flicker between frames that SfM and training both dislike.
            </li>
            <li>
              <strong>Shutter no slower than 1/120 s</strong> indoors, 1/250 s outdoors. Motion blur is the number-one cause of failed camera tracking. Raise ISO before slowing the shutter.
            </li>
            <li>
              <strong>HDR off, Active HDR off</strong>. Standard colour profile, no in-camera sharpening if the option exists.
            </li>
            <li>Clean both lenses before every take. A fingerprint becomes a blurry cloud that follows the camera.</li>
          </ul>
        </Section>

        <Section id="rig" title="Rig and height" figure={<Figure caption="The invisible stick disappears in the stitch and the pipeline masks the nadir (the bottom of the sphere), so the operator is mostly hidden."><StickFigure /></Figure>}>
          <ul>
            <li>
              Mount on the <strong>invisible selfie stick</strong> or a monopod, fully extended, camera at <strong>about 1.6 m</strong> (eye height). Hold the stick out to the side and slightly ahead so your body is below and behind the camera.
            </li>
            <li>
              Keep the camera <strong>level</strong>: the equator of the sphere should stay horizontal. Do not tilt it up at ceilings or down at floors; the pinhole views already cover them.
            </li>
            <li>Do not spin the camera on the stick. Turn your whole body slowly at corners.</li>
            <li>For an object rather than a room, keep the same height and walk a circle at 1.5–2 m radius, then a second, closer circle.</li>
          </ul>
        </Section>

        <Section id="path" title="Walking the scene" figure={<Figure caption="At 0.5 m/s the pipeline keeps one sharp keyframe every half metre, which gives neighbouring frames the 70–80 % overlap SfM needs."><SpeedFigure /></Figure>}>
          <ul>
            <li>
              Walk <strong>slowly and smoothly, about 0.5 m/s</strong> (half normal walking pace). A 30 s clip covers roughly 15 m of path; a typical room takes 1–2 minutes.
            </li>
            <li>
              Shoot <strong>overlapping loops</strong>: one loop around the perimeter, one through the middle, and always return to where you started so the loop closes. Cross your own path at least twice.
            </li>
            <li>Get within 1–1.5 m of the surfaces you care about. Detail comes from proximity, not from resolution.</li>
            <li>Move through doorways slowly and pause for a second on each side so both rooms share frames.</li>
            <li>Keep one continuous clip. Cuts are fine but every clip must be run as its own project.</li>
          </ul>
          <Figure caption="Plan: loops in each room (dashed) plus a connecting loop (solid) so every part of the scene is seen from many angles.">
            <LoopsFigure />
          </Figure>
        </Section>

        <Section id="avoid" title="What to avoid">
          <ul>
            <li>
              <strong>Motion blur:</strong> no fast turns, no stairs at speed, no shooting while stepping over things.
            </li>
            <li>
              <strong>Moving people, pets and vehicles.</strong> Anything that moves appears as ghosts and steals features from static geometry. Clear the space or shoot when it is empty.
            </li>
            <li>
              <strong>Mirrors, glass and glossy floors.</strong> Reflections are geometry that is not there. Cover mirrors or accept holes.
            </li>
            <li>
              <strong>Thin structures</strong> (railings, cables, plant stems, chain-link) reconstruct poorly. Get closer and slower if they matter.
            </li>
            <li>
              <strong>Large blank walls and repetitive patterns</strong> confuse feature matching. Keep some textured objects in view; a few tags on a blank wall help a lot.
            </li>
            <li>
              <strong>Changing light:</strong> do not switch lights, open blinds or wait for clouds mid-take. Outdoors, shoot in overcast light and avoid direct sun in the lens.
            </li>
          </ul>
        </Section>

        <Section id="tags" title="AprilTags for scale and level" figure={<Figure caption="Tags on the floor give scale and the ground plane. A few on walls help in tall rooms and stairwells."><LoopsFigure /></Figure>}>
          <p>
            Without tags the reconstruction is correct up to an unknown scale and rotation. With tags the exported splat is in metres and the floor is level, which is what AR, measurement and multi-scene work need.
          </p>
          <ul>
            <li>
              Print <strong>8–16 tags</strong> from the <Link to="/tags" className="text-accent underline">Tag printer</Link>, family <code>tag36h11</code>, 200 mm for rooms, 300 mm and up for halls and outdoors.
            </li>
            <li>
              <strong>Spread them around the whole path</strong> and at <strong>different heights</strong>: most flat on the floor, a few on walls at 1–1.5 m. Do not cluster them.
            </li>
            <li>
              From most positions on the route <strong>at least 3 tags should be visible</strong> within 3–4 m. Add more tags rather than larger ones.
            </li>
            <li>Mount them flat (tape all four corners), matte paper, no glare. A curled tag has the wrong size.</li>
            <li>
              Enter the exact printed size in the project settings. The pipeline uses it for scale; a 5 % size error is a 5 % scale error.
            </li>
          </ul>
        </Section>

        <Section id="export" title="Export from Insta360 Studio" figure={<Figure caption="The pipeline needs a stitched equirectangular MP4. Raw .insv files are dual-fisheye and cannot be used directly."><ExportFigure /></Figure>}>
          <ol>
            <li>Import the clip from the camera or SD card into Insta360 Studio.</li>
            <li>
              Choose <strong>Export → Video</strong>, projection <strong>360° (equirectangular)</strong>, resolution <strong>8K (7680 × 3840)</strong>.
            </li>
            <li>
              Codec <strong>H.265</strong> (or H.264 if your machine decodes it faster). Highest bitrate offered.
            </li>
            <li>
              <strong>FlowState stabilization on</strong>: a level, stabilised horizon makes every downstream stage easier.
            </li>
            <li>
              <strong>Direction Lock off</strong>: with it on, the frame no longer follows your heading and the pinhole views drift.
            </li>
            <li>No colour effects, no LUT, no denoise. Export the whole clip; trim in the project settings instead.</li>
          </ol>
        </Section>

        <Section id="failures" title="Common failure modes and fixes">
          <table className="table">
            <thead>
              <tr>
                <th>Symptom</th>
                <th>Likely cause</th>
                <th>Fix</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Footage rejected: not equirectangular / .insv', 'Raw camera file or wrong export projection', 'Re-export from Insta360 Studio as 360° equirectangular MP4.'],
                ['SfM registers < 60 % of views', 'Motion blur, blank walls, walking too fast', 'Slower shutter is not the fix: raise ISO, walk at 0.5 m/s, add texture or tags. Try the ring8 layout and a larger sequential window in Settings.'],
                ['Several separate models found', 'Loops did not close, doorway crossed too fast', 'Re-shoot with a connecting loop; enable loop-closure stride 5–10.'],
                ['Scale wrong or floor tilted', 'Wrong tag size in settings, tags not flat, fewer than 3 tags seen', 'Measure the printed tag, fix the size, spread tags out; check the Tags tab coverage.'],
                ['Ghost people / smears', 'Moving people or reflections', 'Clear the scene, cover mirrors, shoot again.'],
                ['Floaters near the camera path', 'Tripod, stick or hand visible; lens dirt', 'Raise the nadir mask radius (Settings → Pinhole views), clean the lenses.'],
                ['Training stops early or is very slow', 'No GPU trainer, too many splats or too high resolution', 'Check Environment; lower max resolution to 1200, max splats to 1.5 M, or use the Fast preset.'],
                ['Blurry detail on walls', 'Camera too far from the surfaces', 'Walk within 1–1.5 m of the surfaces; use more keyframes.'],
              ].map(([a, b, c]) => (
                <tr key={a}>
                  <td className="font-medium">{a}</td>
                  <td className="text-muted">{b}</td>
                  <td>{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </div>
  );
}
