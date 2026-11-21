import { ArrowLeft, ArrowRight, Pause, Play } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { FitTempoBrand } from "./FitTempoBrand";
import { TempoCanvas } from "./TempoCanvas";

const features = [
  {
    title: "Pantry and Budget Meal Planner",
    photo: "account-pantry",
    description: "Plan meals around what you have and see what you still need to buy.",
  },
  {
    title: "Fit My Week",
    photo: "account-runner",
    description: "Move a missed workout to a free slot or choose a shorter version that fits.",
  },
  {
    title: "Meal and workout tracking",
    photo: "account-tracking",
    description: "See what you ate and log the sets you completed as you go.",
  },
] as const;

const autoplayInterval = 6000;

function FeatureCarousel() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const feature = features[index];
  const autoplay = playing && !hovered && !focused && !reducedMotion;

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!autoplay) return;
    const timeout = window.setTimeout(() => setIndex((index + 1) % features.length), autoplayInterval);
    return () => window.clearTimeout(timeout);
  }, [autoplay, index]);

  function choose(position: number) {
    setIndex((position + features.length) % features.length);
    setPlaying(false);
  }

  return (
    <section className="account-features" aria-roledescription="carousel" aria-label="Fit Tempo features"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}>
      <div className="account-feature-art">
        {features.map(({ photo }, position) => (
          <img key={photo} className="account-hero-image" data-active={position === index}
            src={`/${photo}.jpg`} srcSet={`/${photo}-640.jpg 640w, /${photo}.jpg 1024w`}
            sizes="(min-width: 56rem) 24rem, 16rem"
            width={1024} height={1536} alt="" />
        ))}
      </div>
      <div className="account-feature-copy">
        {features.map(({ title, description }, position) => (
          <div key={title} data-active={position === index} aria-hidden={position !== index}
            role="group" aria-roledescription="slide" aria-label={`${position + 1} of ${features.length}`}>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
        ))}
      </div>
      <div className="account-carousel-controls">
        {!reducedMotion && (
          <button type="button" aria-label={playing ? "Pause slideshow" : "Play slideshow"}
            onClick={() => setPlaying((current) => !current)}>
            {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
          </button>
        )}
        <button type="button" aria-label="Previous feature" onClick={() => choose(index - 1)}><ArrowLeft size={20} aria-hidden="true" /></button>
        <div className="account-slide-markers" role="group" aria-label="Choose a feature">
          {features.map(({ title }, position) => (
            <button key={title} type="button" aria-label={title}
              aria-current={position === index ? "true" : undefined}
              onClick={() => choose(position)} />
          ))}
        </div>
        <button type="button" aria-label="Next feature" onClick={() => choose(index + 1)}><ArrowRight size={20} aria-hidden="true" /></button>
        <span className="sr-only" role="status" aria-live={autoplay ? "off" : "polite"}>
          {feature.title}, slide {index + 1} of {features.length}
        </span>
      </div>
    </section>
  );
}

export function AccountLayout({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <main className="tempo-canvas account-layout">
      <TempoCanvas />
      <div className="account-layout-grid">
        <a href="#account-heading" className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:rounded-lg focus:bg-card focus:p-3">
          Skip to account form
        </a>
        <FeatureCarousel />
        <section className="account-form-card" aria-labelledby="account-heading">
          <div className="account-form-inner">
            <FitTempoBrand />
            <h1 id="account-heading" tabIndex={-1}>{title}</h1>
            {intro}
            {children}
          </div>
        </section>
      </div>
    </main>
  );
}
