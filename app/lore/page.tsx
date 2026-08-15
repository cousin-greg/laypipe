import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import styles from "./lore.module.css";

const DOMGE_SHA =
  "05450b2360b7591058bb19bc050b6c84546851d75d6623e1867e0e96b0a3f9b2";
const BALLTZE_SHA =
  "6dafce84d7e7bbc8648aee1c796951af441f399069e88d24f5af2609326fe0fd";
const PIPEDOG_SHA =
  "63aff55aee85927751388adb21375f04cb6c02718494778937ade49fae1e880a";
const DOGE_SHA =
  "0e073bf5219341a6901235a5ce163981b4c26a7873c14331d03fd2ce90c8d8f3";
const DETECTIVE_CHEEMS_SHA =
  "a4d481d7aaad833e0b14db876844368817a092f75d57cb273e8c1c40b58328ce";
const RUSHMORE_LIVE_SHA =
  "df0d96640ddf31dc1bedf8fa6d64a931329396fc75522ef4b50d0b86507652bf";
const LIVE_SITE_CHECKED = "2026-08-14";

const sourceImageTimeline = [
  {
    year: "2010",
    dateTime: "2010-02-13",
    title: "Doge / Kabosu",
    image: "/lore/doge-2010.jpg",
    width: 959,
    height: 540,
    alt: "Kabosu in the 2010 family-blog photograph that became Doge",
    copy: "The cultural ancestor. Kabosu opened the image language, but her pixels are not used in PipeDog.",
    href: "https://kabosu112.exblog.jp/9944144/",
    source: "Atsuko Sato's original blog post",
    status: "primary source",
    role: "cultural ancestry / no shared pixels",
    relevance:
      "Doge established a reusable Shiba image-language: detached captions, deliberate grammatical wrongness, and recognition strong enough to survive endless edits.",
    localHash: DOGE_SHA,
  },
  {
    year: "2017",
    dateTime: "2017-09-04",
    title: "Balltze / Cheems",
    image: "/lore/cheems-2017.jpg",
    width: 1080,
    height: 1080,
    alt: "Balltze sitting on the floor in the source photograph later used for Cheems",
    copy: "The exact photograph behind Cheems and the dog layer that later becomes Domge.",
    href: "https://www.instagram.com/p/BYntbPTF1_f/",
    source: "@balltze on Instagram",
    status: "primary source",
    role: "pixel ancestry",
    relevance:
      "Cheems turned one family photograph into a recurring network character. The same photograph is the material later distorted into Domge.",
    localHash: BALLTZE_SHA,
  },
  {
    year: "2018",
    dateTime: "2018-09-30",
    title: "Walter / Nelson",
    image: "/lore/walter-2018.png",
    width: 799,
    height: 450,
    alt: "Nelson the bull terrier in the source photograph later known as Walter",
    copy: "A parallel dog-meme source later gathered into pipedog.xyz's Rushmore image.",
    href: "https://twitter.com/PupperNelson/status/1046428179618045952",
    source: "@PupperNelson source post",
    status: "primary source",
    role: "pipedog.xyz constellation / no shared pixels",
    relevance:
      "Walter shows how dog memes became a cast rather than a single template. He enters this record because pipedog.xyz places him on its dog Rushmore, not because PipeDog uses his image.",
    localHash:
      "2ba39e9932e4dc3556f685bdc45fadd69bfc0a1d19f1769d2057a23262005fbc",
  },
  {
    year: "2018",
    dateTime: "2018-11-17",
    title: "Dogwifhat / Achi",
    image: "/lore/dogwifhat-2018.jpg",
    width: 1920,
    height: 1080,
    alt: "Achi the Shiba Inu wearing the pink knitted hat used for dogwifhat",
    copy: "Another source photograph later assembled into the official Rushmore image.",
    href: "https://www.instagram.com/p/BqRvWYiHoKl/",
    source: "@bangdddd on Instagram",
    status: "primary source",
    role: "pipedog.xyz constellation / no shared pixels",
    relevance:
      "Dogwifhat reduced a meme to a blunt found-image proposition: a dog with a hat. Its appearance on pipedog.xyz's Rushmore locates PipeDog inside that broader visual economy.",
    localHash:
      "1b56048ffc0545fbda3ca8b3c6e62a30a35b63a39386fea3dc597442ccfcff84",
  },
  {
    year: "2020",
    dateTime: "2020-03-01",
    title: "Domge PNG",
    image: "/brand/pipedog-domge-source.png",
    width: 1139,
    height: 1138,
    alt: "The transparent distorted Domge PNG used beneath PipeDog",
    copy: "The exact distorted Balltze cutout beneath canonical PipeDog. The uploader did not claim to have made the edit.",
    href: "https://www.reddit.com/r/dogelore/comments/fbzzbg/domge_png/",
    source: "earliest located public post",
    status: "exact file",
    role: "direct pixel lineage",
    relevance:
      "Domge is the decisive mutation: the Balltze photograph becomes a reusable transparent body whose wrong geometry is stable enough to identify across later composites.",
    localHash: DOMGE_SHA,
  },
  {
    year: "2020",
    dateTime: "2020-10-22",
    title: "Detective Cheems",
    image: "/lore/detective-cheems-2020.png",
    width: 360,
    height: 450,
    alt: "Cheems wearing a detective hat and holding a curved pipe",
    copy: "The earliest located appearance of this detective cutout. The post's comments call it a repost, so its maker remains unknown.",
    href: "https://www.reddit.com/r/cheemsburbgerlore/comments/jg7sg7/detective_cheems_looks_around_for_clues/",
    source: "earliest located appearance",
    status: "creator unverified",
    role: "composition precedent / direct source unproven",
    relevance:
      "The detective costume shows the culture independently converging on Cheems-as-investigator. It is useful context, but there is no evidence that this post supplied PipeDog's costume layers.",
    localHash: DETECTIVE_CHEEMS_SHA,
  },
  {
    year: "2021",
    dateTime: "2021-03-18",
    title: "Literally all Balkan grandpa's",
    image: "/lore/balkan-grandpa-2021.jpg",
    width: 710,
    height: 1180,
    alt: "Captioned meme reading literally all Balkan grandpa's above detective Cheems",
    copy: "The exact Memes.com post briefly cited below, now shown in the sequence. It is adjacent evidence, not the canonical PipeDog file.",
    href: "https://api.memes.com/m/literally-all-balkan-grandpa-s-0mWw61GeqW3",
    source: "@leviaxpetra_aot on Memes.com",
    status: "exact post",
    role: "circulation evidence / direct source unproven",
    relevance:
      "The post proves that a pipe-smoking detective Cheems was already circulating before LayPipe. It does not prove who assembled canonical PipeDog.",
    localHash:
      "7595ade529ad0d8d92de6df5db0df2bbe111905df897fcb8814260033305f3a8",
  },
  {
    year: "2026",
    dateTime: "2026",
    title: "The great dogs on the mountain",
    image: "/lore/dog-rushmore-2026-display.webp",
    width: 1536,
    height: 1024,
    alt: "The official pipedog.xyz collage of four meme dogs carved into a mountain",
    copy: "The current pipedog.xyz collage brings Doge, Cheems, Walter, and dogwifhat into one official site image.",
    href: "https://pipedog.xyz/dog_rushmore_wut.png",
    source: "pipedog.xyz",
    status: "current site snapshot",
    role: "official project context / no body pixels",
    relevance:
      "The current site makes its own canon visible by placing Doge, Cheems, Walter, and dogwifhat together. That grouping is project context, not a claim that all four images form PipeDog's pixel lineage.",
    localHash:
      "321c76db5691ac4497de9885c5e7f238f19f93a10bf500cb6c3ad05262a68163",
  },
  {
    year: "date unknown",
    title: "Canonical PipeDog",
    image: "/brand/pipedog.png",
    width: 386,
    height: 351,
    alt: "The canonical PipeDog detective composite from pipedog.xyz",
    copy: "The exact project canonical. Its first publication date and the assembler of the costume remain unresolved.",
    href: "https://pipedog.xyz/pipedog.png",
    source: "pipedog.xyz",
    status: "exact file / date unresolved",
    role: "canonical flattened work",
    relevance:
      "PipeDog turns Domge into a singular character through found costume fragments. The exact file is confirmed; its first publication date and assembler remain open questions.",
    localHash: PIPEDOG_SHA,
  },
] as const;

const collectionBuildGroups = [
  {
    name: "Backgrounds",
    note: "Square found-world scenes with room for the unchanged Domge cutout.",
    items: [
      "Nicotine-stained motel room",
      "Roadside motel exterior at blue hour",
      "Night corner store",
      "Pawnshop back room",
      "Fluorescent laundromat",
      "Red-vinyl diner booth",
      "Wood-paneled CRT den",
      "Wet service alley",
      "Cluttered garage workbench",
      "Municipal pipe and valve room",
      "Rain-soaked smoking patio",
      "Late-night LayPipe trading desk",
    ],
  },
  {
    name: "Clothing and neck",
    note: "Photographed garments and separate chest accessories.",
    items: [
      "Navy thrift-store track jacket",
      "Tan trench coat",
      "Green raincoat",
      "Orange hi-vis vest",
      "Mechanic coveralls",
      "Wrinkled shirt and tie",
      "Plaid bathrobe",
      "Pipefitter work shirt",
      "Thrifted leather jacket",
      "Chunky gold chain",
      "Thin motel-key chain",
      "Red bandana",
    ],
  },
  {
    name: "Headwear and eyewear",
    note: "Additive cutouts only; the inherited Domge face stays untouched.",
    items: [
      "Canonical deerstalker",
      "Red trucker cap",
      "Tinfoil cone",
      "Green accountant visor",
      "Scuffed hard hat",
      "Fisherman bucket hat",
      "Worn knit beanie",
      "Amber wraparound glasses",
      "Tiny oval sunglasses",
      "Scratched aviators",
      "Yellow safety glasses",
      "Cardboard 3D glasses",
    ],
  },
  {
    name: "Mouth, smoke, and steam",
    note: "One mouth object and one physically compatible effect at most.",
    items: [
      "Straight briar pipe",
      "Corn-cob pipe",
      "Small bent pipe",
      "Lit or unlit cigarette",
      "Wooden toothpick",
      "Dog biscuit",
      "Vintage cigarette holder",
      "Single smoke curl",
      "Heavy sideways smoke",
      "Coffee steam",
      "Cold breath",
      "Cigarette ember",
    ],
  },
  {
    name: "Found cigarette packs",
    note: "Photographed found objects with their real logos left visible.",
    items: [
      "Marlboro Red",
      "Newport",
      "Lucky Strike",
      "Camel Filters",
      "Kool",
      "Salem",
      "Parliament",
      "American Spirit turquoise",
      "Winston",
      "Djarum Black",
    ],
  },
  {
    name: "Props and trinkets",
    note: "Oversized physical evidence, shot with direct flash and honest wear.",
    items: [
      "Heavy glass ashtray",
      "Motel key tag 207",
      "Translucent flip phone",
      "Numeric pager",
      "Disposable camera",
      "Portable CRT television",
      "Magnifying glass",
      "Red pipe wrench",
      "Pawn ticket",
      "VHS tape marked EVIDENCE",
      "Pressure gauge",
      "100,000 LAYPIPE receipt",
    ],
  },
  {
    name: "Friends",
    note: "Original or cleared supporting characters, never borrowed NFT cutouts.",
    items: [
      "Side-eye pigeon",
      "Trash-can raccoon",
      "Nighttime opossum",
      "Snail on a motel key",
      "Skeptical crow",
      "Moth at a fluorescent light",
      "Frog on a pipe valve",
      "Cockroach by the ashtray",
      "Parking-lot goose",
      "Original sentient valve",
    ],
  },
  {
    name: "Overlays",
    note: "One full-frame treatment, kept outside protected Domge pixels.",
    items: [
      "Camera-flash bloom",
      "Scanner dust and hair",
      "VHS scanlines",
      "Orange date stamp",
      "No Vacancy reflection",
      "Black redaction tape",
      "Sticker residue",
      "CCTV timestamp",
      "Greasy fingerprints",
      "Original SELL ONLY interface",
    ],
  },
] as const;

export const metadata: Metadata = {
  title: "The Dog Was Already Here | PipeDog Lore",
  description:
    "The documented lineage of PipeDog: Doge, Balltze, Cheems, Domge PNG, the detective composite, and LayPipe's found-image ethos.",
  openGraph: {
    title: "The Dog Was Already Here",
    description:
      "A PipeDog provenance and a manifesto for the found image.",
    url: "https://laypipe.fun/lore",
    images: [
      {
        url: "/brand/pipedog.png",
        width: 386,
        height: 351,
        alt: "The canonical PipeDog detective composite",
      },
    ],
  },
};

export default function LorePage() {
  return (
    <main className={styles.page} id="top">
      <article>
        <header className={styles.masthead}>
          <p className={styles.kicker}>PIPE DOG PROVENANCE / FILE 001</p>
          <h1>The dog was already here.</h1>
          <p className={styles.dek}>
            A provenance of PipeDog, a defense of the ugly cutout, and a rule
            for everything LayPipe makes next: add to the image without erasing
            where it came from.
          </p>
          <div className={styles.byline}>
            <span>Published by LayPipe</span>
            <time dateTime="2026-08-13">August 13, 2026</time>
            <span>Updated August 14, 2026</span>
            <span>Living document / sources can change</span>
          </div>
          <nav className={styles.articleIndex} aria-label="Lore article index">
            <a href="#lineage">01 lineage</a>
            <a href="#domge">02 mutation</a>
            <a href="#detective">03 detective</a>
            <a href="#ethos">04 ethos</a>
            <a href="#collection">05 collection</a>
            <a href="#build-list">06 build list</a>
            <a href="#ledger">07 receipts</a>
          </nav>
        </header>

        <figure className={styles.heroArtifact}>
          <div className={styles.sourcePanel}>
            <span>2020 source artifact</span>
            <Image
              src="/brand/pipedog-domge-source.png"
              alt="The exact transparent Domge PNG source used beneath PipeDog"
              width={1139}
              height={1138}
              sizes="(max-width: 820px) calc(100vw - 68px), 45vw"
              priority
              loading="eager"
            />
            <code>SHA-256 {DOMGE_SHA}</code>
          </div>
          <div className={styles.canonicalPanel}>
            <span>Canonical PipeDog composite</span>
            <div className={styles.canonicalImage}>
              <Image
                src="/brand/pipedog.png"
                alt="The canonical PipeDog wearing a detective hat and cape with a pipe"
                width={386}
                height={351}
                sizes="(max-width: 820px) calc(100vw - 68px), 45vw"
                priority
                loading="eager"
              />
            </div>
            <code>SHA-256 {PIPEDOG_SHA}</code>
          </div>
          <figcaption>
            Same nose. Same eye. Same collapsed geometry. The costume arrived
            later; the mutation underneath it is exact.
          </figcaption>
        </figure>

        <section className={styles.prologue}>
          <p className={styles.dropcap}>
            LayPipe did not invent this dog. The contract came later. The coin
            came later. The plan for 10,000 Lay Pipedogs came later. Before
            any of that, there was a photograph, then a character, then a
            transparent PNG dropped into a subreddit and released into the
            weather system of the internet.
          </p>
          <p>
            We begin with that admission because it is the point. A meme is
            not born when a project claims it. It becomes real through
            circulation: saved, cut out, compressed, reposted, misnamed,
            dressed up, detached from context, and recognized anyway. PipeDog
            is one stop in that relay. Our job is not to clean the relay up.
            Our job is to keep the receipt.
          </p>
        </section>

        <section
          className={`${styles.section} ${styles.lineageSection}`}
          id="lineage"
        >
          <p className={styles.sectionLabel}>01 / THE LINEAGE</p>
          <h2>PipeDog is Doge lore. PipeDog is not the Doge photograph.</h2>
          <p>
            The distinction matters. The original Doge image is Kabosu, the
            Japanese rescue Shiba photographed by Atsuko Sato and posted to her
            blog on February 13, 2010. Kabosu supplied the face that became
            Doge: crossed paws, side-eye, Comic Sans, a new grammar built from
            deliberate wrongness. That image opened the door, but it is not
            the body inside PipeDog.
          </p>
          <p>
            PipeDog&apos;s body is Balltze, the Hong Kong Shiba later known as
            Cheems. Balltze&apos;s owner posted the source photograph to the
            dog&apos;s Instagram on September 4, 2017. By 2019 the round face,
            awkward sit, and misspelled appetite had entered r/dogelore: a
            shared cast of dogs whose identities were built collectively,
            inconsistently, and in public.
          </p>
          <p>
            Here are the names we use. PipeDog, singular, is that inherited
            detective composite: the exact Domge PNG beneath a deerstalker,
            plaid cape, and bent pipe. Lay Pipedogs is LayPipe&apos;s planned
            collection. Every Lay Pipedog begins with that same exact Domge
            cutout, then applies PipeDog&apos;s found-image construction and
            net-art ideals through new rooms, clothes, objects, and collisions.
            It is not 10,000 copies of the flattened detective composite.
          </p>
          <p>
            Kabosu and the Doge photograph are cultural ancestors, not pixel
            sources for PipeDog or Lay Pipedogs. Domge, derived from the
            Balltze/Cheems image, is the consistent dog layer in both.
            The collection is not official r/dogelore canon, and LayPipe does
            not claim to have created Balltze, Cheems, Domge, or any earlier
            image in the lineage.
          </p>

          <aside className={styles.twoTrees} aria-label="Cultural ancestry and pixel lineage">
            <div>
              <strong>Cultural ancestry</strong>
              <p>
                Doge / Kabosu → the dog-meme grammar → dogelore&apos;s shared cast
                → the visual conditions in which PipeDog can be read instantly.
              </p>
            </div>
            <div>
              <strong>Direct pixel lineage</strong>
              <p>
                Balltze source photograph → Cheems character → exact Domge PNG
                → canonical flattened PipeDog → exact Domge body in Lay Pipedogs.
              </p>
            </div>
          </aside>

          <div className={styles.culturalChronology}>
            <p>
              <strong>2005 / the word.</strong> Homestar Runner&apos;s
              <a
                href="https://homestarrunner.com/toons/biz-cas-fri-1"
                target="_blank"
                rel="noreferrer"
              >
                Biz Cas Fri 1
              </a>
              records the misspelling &ldquo;doge&rdquo; before the famous photograph
              carried it.
            </p>
            <p>
              <strong>2013 / the grammar becomes infrastructure.</strong>
              <a
                href="https://dogecoin.com/dogepedia/articles/history-of-dogecoin/"
                target="_blank"
                rel="noreferrer"
              >
                Dogecoin launches on December 6
              </a>
              and Doge moves from caption language into a payment token and
              tipping culture: evidence that internet vernacular can organize
              an economy without becoming visually respectable first.
            </p>
            <p>
              <strong>2018–2020 / the cast becomes modular.</strong> Dogelore
              treats transparent dog cutouts as reusable actors. Names,
              personalities, and relationships emerge from posting rather than
              from a single official author.
            </p>
          </div>

          <div className={styles.timelineIntro}>
            <p>
              The cultural history is wider than any one file. This strip stays
              narrower: the source images themselves, ordered by the year each
              exact post or earliest located appearance entered the record.
            </p>
            <span>
              Status labels separate confirmed files, cultural context, and
              unresolved attribution.
            </span>
          </div>

          <ol
            className={styles.sourceTimeline}
            aria-label="PipeDog source images by year"
          >
            {sourceImageTimeline.map((entry) => (
              <li key={`${entry.year}-${entry.title}`}>
                <div className={styles.timelineYear}>
                  {"dateTime" in entry ? (
                    <time dateTime={entry.dateTime}>{entry.year}</time>
                  ) : (
                    <span>{entry.year}</span>
                  )}
                </div>
                <figure className={styles.timelineFigure}>
                  <div className={styles.timelineImage}>
                    <Image
                      src={entry.image}
                      alt={entry.alt}
                      width={entry.width}
                      height={entry.height}
                      sizes="(max-width: 720px) calc(100vw - 48px), 560px"
                    />
                  </div>
                  <figcaption>
                    <div className={styles.receiptFlags}>
                      <span>{entry.status}</span>
                      <em>{entry.role}</em>
                    </div>
                    <h3>{entry.title}</h3>
                    <p>{entry.copy}</p>
                    <p className={styles.relevance}>
                      <strong>Why it mattered:</strong> {entry.relevance}
                    </p>
                    <dl className={styles.sourceMeta}>
                      <div>
                        <dt>Source</dt>
                        <dd>
                          <a href={entry.href} target="_blank" rel="noreferrer">
                            {entry.source} ↗
                          </a>
                        </dd>
                      </div>
                      <div>
                        <dt>Local file</dt>
                        <dd>
                          <code title={entry.localHash}>
                            sha256:{entry.localHash.slice(0, 12)}…
                          </code>
                        </dd>
                      </div>
                    </dl>
                  </figcaption>
                </figure>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.section} id="domge">
          <p className={styles.sectionLabel}>02 / THE MUTATION</p>
          <h2>The wrong proportions are the right file.</h2>
          <p>
            On March 1, 2020, Gary-Oto uploaded Domge PNG. The file is 1,139 by
            1,138 pixels with transparency. Know Your Meme archived a copy the
            same day and points back to Reddit. The Reddit file and the archive
            are byte-for-byte identical. Their SHA-256 is printed above. No
            evidence currently establishes who performed the distortion.
          </p>
          <p>
            What happened to Balltze in that PNG is not restoration. The body
            has been stretched, folded, and badly negotiated with itself. Legs
            emerge at implausible angles. The eye survives as a black sliver.
            The chest becomes architecture. It is funny because the source is
            still legible through the damage.
          </p>
          <blockquote>
            Do not fix the dog. The distortion is not damage around the work.
            The distortion is the work.
          </blockquote>
          <p>
            Our measured reconstruction aligns the source to the canonical
            PipeDog at approximately a 380 by 380 pixel cubic resize placed at
            x=4, y=89 on the 386 by 351 canvas. The nose, eye, muzzle, chest,
            and flank land together. This demonstrates the source relationship;
            it does not pretend to recover the original Photoshop document.
          </p>
        </section>

        <section className={styles.section} id="detective">
          <p className={styles.sectionLabel}>03 / THE DETECTIVE</p>
          <h2>A costume made of other people&apos;s pictures.</h2>
          <p>
            PipeDog takes Domge and gives him a job. The deerstalker is an exact
            match for Shutterstock image 1527641588 by Victor Moussa: ribbon,
            knot, seams, brim, weave, every fold. The grey cape matches a
            commercially sold pet-detective garment, although the precise frame
            used in the composite remains unproven. The pipe is still
            unidentified. Every surfaced candidate changes the bowl, stem,
            banding, or light.
          </p>
          <p>
            That uncertainty stays in the record. Provenance is not a mood
            board where the closest-looking image wins. Confirmed means
            confirmed. Probable means probable. Unknown remains unknown until
            the network produces better evidence.
          </p>
          <p>
            By March 2021, the exact Domge body was already circulating in an
            <a
              href="https://api.memes.com/m/literally-all-balkan-grandpa-s-0mWw61GeqW3"
              target="_blank"
              rel="noreferrer"
            >
              adjacent pipe-smoking detective meme
            </a>
            captioned &ldquo;literally all Balkan grandpa&apos;s.&rdquo; It is
            not the canonical PipeDog file and cannot be called its direct
            source. It is evidence that this mutation was already available in
            the culture before LayPipe named the character.
          </p>
        </section>

        <section className={styles.manifesto} id="ethos">
          <div className={styles.manifestoIntro}>
            <p className={styles.sectionLabel}>04 / WHAT LAYPIPE BELIEVES</p>
            <h2>The network is the studio. The archive is part of the art.</h2>
            <p>
              Remilia&apos;s 2021
              <a
                href="https://blog.remilia.org/what-remilia-believes-in-a-new-net-art-manifesto/"
                target="_blank"
                rel="noreferrer"
              >
                net-art manifesto
              </a>
              argues that posting can be an artistic medium and that network
              culture grows beyond a single author. We share the first premise
              and push against the easy conclusion of the second: distributed
              authorship makes memory more important, not less. A work can
              belong to the network without becoming historically blank.
            </p>
          </div>

          <div className={styles.belief}>
            <span>1</span>
            <div>
              <h3>Lineage without possession.</h3>
              <p>
                Recording who posted a file, when it appeared, and how it
                changed is not an attempt to own the culture around it.
                Provenance is memory. It names the hands in the relay without
                pretending the relay has an endpoint.
              </p>
            </div>
          </div>

          <div className={styles.belief}>
            <span>2</span>
            <div>
              <h3>The file is an artifact.</h3>
              <p>
                A meme is not merely the idea of a picture. Dimensions matter.
                Compression matters. Transparency matters. A hash lets us say
                that this file—not a cleaned-up substitute and not an AI
                recollection—is the one that traveled here.
              </p>
            </div>
          </div>

          <div className={styles.belief}>
            <span>3</span>
            <div>
              <h3>The seam is the signature.</h3>
              <p>
                Bad Photoshop is a native internet medium. Hard cutout edges,
                mismatched flash, the wrong perspective, a white halo, and a
                prop pasted two pixels too low all preserve the act of making.
                Smoothness can erase more than it improves.
              </p>
            </div>
          </div>

          <div className={styles.belief}>
            <span>4</span>
            <div>
              <h3>Mutation belongs around the core.</h3>
              <p>
                PipeDog is inherited; Lay Pipedogs is the mutation LayPipe is
                responsible for. We keep the exact Domge dog and change the
                rooms, clothes, hats, props, friends, cigarette packs, and
                commercial debris around it. Dogelore supplies a shared remix
                grammar; LayPipe is responsible for the collection system and
                the finished combinations.
              </p>
            </div>
          </div>

          <div className={styles.belief}>
            <span>5</span>
            <div>
              <h3>Keep the marks on the objects.</h3>
              <p>
                A Marlboro pack without its roof, a Newport pack without its
                swoosh, or a Lucky Strike pack without its target is not the
                same found object. Sanitizing logos launders the cultural
                specificity out of the image. Lay Pipedogs preserves the
                packaging, typography, wear, and embarrassment of the real
                thing. This is found visual culture, not brand sponsorship.
              </p>
            </div>
          </div>

          <div className={styles.belief}>
            <span>6</span>
            <div>
              <h3>Posting is circulation; archiving is care.</h3>
              <p>
                The post gives the image velocity. The archive gives it a past.
                LayPipe needs both: images built to move and records built to
                survive the platforms that moved them.
              </p>
            </div>
          </div>
        </section>

        <section className={styles.section} id="collection">
          <p className={styles.sectionLabel}>05 / THE COLLECTION</p>
          <h2>One inherited dog layer. Ten thousand new compositions.</h2>
          <p>
            The singular PipeDog is a specific flattened detective image. The
            Lay Pipedogs collection begins with the exact high-resolution Domge
            cutout beneath it and builds outward with sourced motel rooms, pawn
            shops, corner stores, cigarette packaging, bootleg electronics,
            thrift-store clothes, trading lore, and other evidence of life on
            the network.
          </p>
          <p>
            The point is not to manufacture a cleaner mascot or place an old
            PNG behind ten thousand arbitrary costumes. The exact Domge file is
            a common visual substrate: one piece of inherited network culture
            that lets every later collision remain visibly related. What
            changes around it records another room, object, joke, market, and
            moment in the life of the network.
          </p>
          <p>
            One locked Sherlock Genesis may preserve canonical PipeDog
            byte-for-byte. The remaining Lay Pipedogs keep the same Domge dog
            pixels but do not pretend the inherited detective costume was a
            modular source file. Ten thousand pieces become a distributed
            anthology rather than ten thousand claims of original authorship.
            Every room, object, and overlay gets a source record; every rendered
            token gets a deterministic recipe.
          </p>
          <div className={styles.ruleCard}>
            <strong>The permanent dog rule</strong>
            <p>
              Preserve the exact Domge pixels in every Lay Pipedog. Preserve
              canonical PipeDog byte-for-byte wherever PipeDog itself appears.
              Preserve real marks on found objects. Keep the source ledger
              public. Label uncertainty. Never pass a generated concept off as
              a photographed or inherited provenance master.
            </p>
          </div>
          <div className={styles.animalNote}>
            <h3>The characters do not replace the dogs.</h3>
            <p>
              Balltze died on August 18, 2023. Kabosu died peacefully on May
              24, 2024. Their families&apos; photographs made this lineage
              possible. The meme can mutate forever without turning the living
              animals and the people who cared for them into invisible raw
              material.
            </p>
            <div>
              <a
                href="https://cheems-balltze.com/pages/our-story"
                target="_blank"
                rel="noreferrer"
              >
                Balltze family history
              </a>
              <a
                href="https://kabochan.blog.jp/archives/51831907.html"
                target="_blank"
                rel="noreferrer"
              >
                Atsuko Sato&apos;s Kabosu memorial
              </a>
            </div>
          </div>
        </section>

        <section className={styles.assetSection} id="build-list">
          <p className={styles.sectionLabel}>06 / WHAT WE ARE MAKING</p>
          <h2>The first collection build list.</h2>
          <p className={styles.assetIntro}>
            These are production targets, not prompts to redraw PipeDog. The
            motel, corner-store, and pawnshop examples establish the range:
            the unchanged Domge dog, ordinary rooms, oversized found objects,
            readable packaging, direct flash, and combinations that feel
            discovered rather than designed. Open a category to inspect the
            working list.
          </p>
          <div className={styles.assetGrid}>
            {collectionBuildGroups.map((group) => (
              <details className={styles.assetGroup} key={group.name}>
                <summary>
                  <span>{group.name}</span>
                  <strong>{group.items.length} targets</strong>
                </summary>
                <p>{group.note}</p>
                <ul>
                  {group.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
          <div className={styles.ruleCard}>
            <strong>The pack rule</strong>
            <p>
              Marlboro, Newport, Lucky Strike, and every later found pack keep
              their real marks, typography, cellophane, tax stamps, damage, and
              awkward scale. We do not blur a logo, invent fake spelling, or
              turn a culturally specific object into a generic box.
            </p>
          </div>
        </section>

        <section className={styles.ledgerSection} id="ledger">
          <p className={styles.sectionLabel}>07 / PROVENANCE LEDGER</p>
          <h2>The receipts.</h2>
          <div className={styles.ledgerWrap}>
            <table>
              <thead>
                <tr>
                  <th>Artifact</th>
                  <th>Earliest located source</th>
                  <th>Local record</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Kabosu / Doge photograph</td>
                  <td>
                    <a
                      href="https://kabosu112.exblog.jp/9944144/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Atsuko Sato original blog, 2010-02-13
                    </a>
                  </td>
                  <td>
                    <code>public/lore/doge-2010.jpg</code>
                    <small>SHA-256 {DOGE_SHA}</small>
                    Cultural ancestor only; no Kabosu pixels in PipeDog or Lay
                    Pipedogs
                  </td>
                  <td>Confirmed</td>
                </tr>
                <tr>
                  <td>Balltze / Cheems photograph</td>
                  <td>
                    <a
                      href="https://www.instagram.com/p/BYntbPTF1_f/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      @balltze, 2017-09-04
                    </a>
                  </td>
                  <td>
                    <code>public/lore/cheems-2017.jpg</code>
                    <small>SHA-256 {BALLTZE_SHA}</small>
                  </td>
                  <td>Confirmed</td>
                </tr>
                <tr>
                  <td>Domge PNG</td>
                  <td>
                    <a
                      href="https://www.reddit.com/r/dogelore/comments/fbzzbg/domge_png/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Gary-Oto / r/dogelore, 2020-03-01
                    </a>
                    <a
                      href="https://knowyourmeme.com/photos/1767872-ironic-doge-memes"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Same-day KYM archive
                    </a>
                  </td>
                  <td>
                    <code>public/brand/pipedog-domge-source.png</code>
                    <small>SHA-256 {DOMGE_SHA}</small>
                  </td>
                  <td>Exact, byte-matched</td>
                </tr>
                <tr>
                  <td>Canonical PipeDog composite</td>
                  <td>
                    <a href="https://pipedog.xyz/pipedog.png" target="_blank" rel="noreferrer">
                      pipedog.xyz/pipedog.png
                    </a>
                  </td>
                  <td>
                    <code>public/brand/pipedog.png</code>
                    <small>SHA-256 {PIPEDOG_SHA}</small>
                  </td>
                  <td>
                    Exact project canonical; byte-matched to the live asset on
                    {` ${LIVE_SITE_CHECKED}`}
                  </td>
                </tr>
                <tr>
                  <td>pipedog.xyz dog Rushmore</td>
                  <td>
                    <a
                      href="https://pipedog.xyz/dog_rushmore_wut.png"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Current official-site asset, checked {LIVE_SITE_CHECKED}
                    </a>
                  </td>
                  <td>
                    Original live PNG snapshot
                    <small>SHA-256 {RUSHMORE_LIVE_SHA}</small>
                  </td>
                  <td>
                    Official site context; not part of PipeDog&apos;s body lineage
                  </td>
                </tr>
                <tr>
                  <td>Detective hat</td>
                  <td>
                    <a
                      href="https://www.shutterstock.com/image-photo/vintage-investigator-retro-inspector-conceptual-idea-1527641588"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Victor Moussa, Shutterstock 1527641588
                    </a>
                  </td>
                  <td>Public preview retained as evidence only</td>
                  <td>Exact source identified</td>
                </tr>
                <tr>
                  <td>Detective Cheems post</td>
                  <td>
                    <a
                      href="https://www.reddit.com/r/cheemsburbgerlore/comments/jg7sg7/detective_cheems_looks_around_for_clues/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Earliest located appearance, 2020-10-22
                    </a>
                  </td>
                  <td>
                    <code>public/lore/detective-cheems-2020.png</code>
                    <small>SHA-256 {DETECTIVE_CHEEMS_SHA}</small>
                  </td>
                  <td>Repost indicated; maker and relation to PipeDog unresolved</td>
                </tr>
                <tr>
                  <td>Plaid cape / bent pipe</td>
                  <td>Garment family matched; exact frames not found</td>
                  <td>Open investigation</td>
                  <td>Unresolved</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className={styles.ledgerNote}>
            This ledger documents lineage. It does not itself grant a license,
            establish endorsement, or convert a public file into exclusive
            property. Sources and usage status are recorded separately because
            those are different facts.
          </p>
        </section>

        <section className={styles.endnote}>
          <p className={styles.sectionLabel}>ENDNOTE</p>
          <p>
            The internet did not hand us a blank canvas. It handed us a dog
            that had already survived being photographed, named, misspelled,
            distorted, cut out, dressed like a detective, and passed from one
            hard drive to another. We will not pretend to be the beginning of
            that story.
          </p>
          <strong>
            Keep PipeDog exact. Let Lay Pipedogs make a stranger network.
          </strong>
          <div className={styles.endLinks}>
            <Link href="/my">Meet Lay Pipedogs</Link>
            <Link href="/docs">Read the protocol docs</Link>
            <a
              href="https://blog.remilia.org/what-remilia-believes-in-a-new-net-art-manifesto/"
              target="_blank"
              rel="noreferrer"
            >
              Read the referenced Remilia manifesto
            </a>
          </div>
        </section>
      </article>
    </main>
  );
}
