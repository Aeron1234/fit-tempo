import { ArrowUpRight, CalendarDays, Dumbbell, ShoppingBasket, Utensils } from 'lucide-react'
import { Link } from 'react-router-dom'
import { InstallFitTempo } from '@/app/pwa'
import './landing.css'

const features = [
  { title: 'Pantry and Budget Meal Planner', icon: ShoppingBasket, image: 'pantry', path: '/app/planner', description: 'Plan meals around what you have and compare estimated costs before you shop.' },
  { title: 'Meal tracking', icon: Utensils, image: 'meals', path: '/app/meals', description: 'Log what you eat and see which meals have nutrition information.' },
  { title: 'Workout tracking', icon: Dumbbell, image: 'workouts', path: '/app/workouts', description: 'Record sets and reps, run a rest timer, and revisit completed sessions.' },
]

const questions = [
  ['How do I install Fit Tempo?', 'Choose Install Fit Tempo above. On iPhone, open the page in Safari and choose Share, then Add to Home Screen. Turn on Open as Web App if shown. On Android, use the Chrome install prompt or the install option in the browser menu.'],
  ['Can I keep using Fit Tempo in my browser?', 'Yes. Choose Open web app and sign in or create an account. You can use the same Fit Tempo account from the browser or the home screen app.'],
  ['Do I need a connection?', 'Yes. Signing in, viewing your account data, and saving logs require a connection.'],
]

function Brand() {
  return <a href="#top" className="landing-brand">
    <img src="/fit-tempo-mark.png" width="34" height="34" alt="" /> Fit Tempo
  </a>
}

export function LandingPage() {
  return <div id="top" className="tempo-canvas landing">
    <header className="landing-header">
      <Brand />
      <nav aria-label="Landing page">
        <a href="#features">Features</a>
        <a href="#faq">FAQ</a>
        <Link to="/app">Open web app <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </nav>
    </header>

    <main>
      <section className="landing-hero" aria-labelledby="hero-title">
        <div className="landing-hero-copy">
          <h1 id="hero-title">Your meals. Your movement. <strong>Your rhythm.</strong></h1>
          <p>Make a plan with what's in your pantry, find time for your workouts, and track both in one place.</p>
          <div className="landing-actions">
            <div><InstallFitTempo /></div>
            <Link className="landing-secondary" to="/app">Open web app <ArrowUpRight size={16} aria-hidden="true" /></Link>
          </div>
        </div>
        <figure className="landing-stage">
          <div className="landing-phone">
            <div className="landing-phone-top"><span>Fit Tempo</span><span>Monday</span></div>
            <h2>Today</h2>
            <div className="landing-phone-entry"><CalendarDays size={19} aria-hidden="true" /><div><strong>Full body</strong><small>Scheduled workout</small></div></div>
            <div className="landing-phone-entry"><Utensils size={19} aria-hidden="true" /><div><strong>Chicken rice bowl</strong><small>Logged lunch</small></div></div>
            <div className="landing-phone-entry"><ShoppingBasket size={19} aria-hidden="true" /><div><strong>Egg rice bowl</strong><small>Pantry meal suggestion</small></div></div>
          </div>
          <figcaption>Sample dashboard</figcaption>
        </figure>
      </section>

      <section id="features" className="landing-feature-section" aria-labelledby="feature-title">
        <h2 id="feature-title">From the kitchen <strong>to the gym.</strong></h2>
        <div className="landing-grid">
          {features.map(({ title, icon: Icon, image, path, description }) => <article key={title}>
            <Link className="landing-feature-link" to={path}>
              <img src={`/landing/${image}.webp`} width="768" height="512" loading="lazy" decoding="async" alt="" />
              <h3><Icon size={19} aria-hidden="true" />{title}<ArrowUpRight size={16} aria-hidden="true" /></h3>
              <p>{description}</p>
            </Link>
          </article>)}
        </div>
      </section>

      <section className="landing-spotlight">
        <img src="/landing/week.webp" width="768" height="512" loading="lazy" decoding="async" alt="" />
        <div>
          <h2>Make room <strong>for movement.</strong></h2>
          <p>Fit My Week helps you see the workouts you’ve planned and review a new time or a shorter routine when your schedule changes.</p>
          <Link className="landing-secondary" to="/app/week">Open Fit My Week <ArrowUpRight size={16} aria-hidden="true" /></Link>
        </div>
      </section>

      <section id="faq" className="landing-faq" aria-labelledby="faq-title">
        <h2 id="faq-title">Getting <strong>started.</strong></h2>
        {questions.map(([question, answer]) => <details key={question}>
          <summary>{question}</summary><p>{answer}</p>
        </details>)}
      </section>
    </main>
    <footer className="landing-header landing-footer">
      <Brand />
      <Link to="/app">Open web app <ArrowUpRight size={15} aria-hidden="true" /></Link>
    </footer>
  </div>
}
