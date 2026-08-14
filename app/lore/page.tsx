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
    <main className={styles.page}>
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
            <span>Living document</span>
          </div>
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
            came later. The 10,000 PipeDogs came later. Before any of that,
            there was a photograph, then a character, then a transparent PNG
            dropped into a subreddit and released into the weather system of
            the internet.
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
          <div className={styles.timelineIntro}>
            <p>
              The cultural history is wider than any one file. This strip stays
              narrower: the source images themselves, ordered by the year each
              exact post or earliest located appearance entered the record.
            </p>
            <span>Scroll the images, then open every receipt.</span>
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
                    <span>{entry.status}</span>
                    <h3>{entry.title}</h3>
                    <p>{entry.copy}</p>
                    <a href={entry.href} target="_blank" rel="noreferrer">
                      {entry.source} ↗
                    </a>
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
                PipeDogs can accumulate hats, rooms, chains, motel keys,
                cameras, cigarette boxes, and a thousand pieces of commercial
                debris. The exact Domge dog remains unchanged beneath them.
                We add context; we do not regenerate the ancestor.
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
                specificity out of the image. PipeDogs preserve the packaging,
                typography, wear, and embarrassment of the real thing. This is
                found visual culture, not brand sponsorship.
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
          <h2>Ten thousand dogs, one unchanged ancestor.</h2>
          <p>
            The PipeDogs collection will be assembled from photographed layers,
            not generated approximations of the dog. Backgrounds and traits
            can come from motel rooms, pawn shops, corner stores, disposable
            cameras, cigarette packaging, bootleg electronics, thrift-store
            clothing, trading lore, and other evidence of life on the network.
            Each accepted layer gets a source record. Each rendered token gets
            a deterministic recipe. The core cutout gets no makeover.
          </p>
          <div className={styles.ruleCard}>
            <strong>The permanent image rule</strong>
            <p>
              Preserve the canonical Domge pixels. Preserve real logos on found
              objects. Keep the source ledger public. Label uncertainty. Never
              pass generated scenery or a visual concept off as a provenance
              master.
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

        <section className={styles.ledgerSection} id="ledger">
          <p className={styles.sectionLabel}>06 / PROVENANCE LEDGER</p>
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
                  <td>Contextual ancestor; not the PipeDog body</td>
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
                  <td>Exact project canonical</td>
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
          <strong>Keep the dog exact. Make the world around him stranger.</strong>
          <div className={styles.endLinks}>
            <Link href="/my">Meet the PipeDogs</Link>
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
