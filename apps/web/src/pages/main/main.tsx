import { Link } from "react-router-dom";
import { CalendarDays, CircleCheck, Clock3 } from "lucide-react";
import "./main.css";

const steps = [
  {
    icon: CalendarDays,
    title: "Выберите дату",
    description: "Доступные дни в календаре",
  },
  {
    icon: Clock3,
    title: "Найдите время",
    description: "Свободные слоты для встречи",
  },
  {
    icon: CircleCheck,
    title: "Подтвердите запись",
    description: "Оставьте имя и электронную почту",
  },
];

export function MainPage() {
  return (
    <div className="container hero">
      <div className="hero-copy">
        <p className="hero-label">Встречи без лишних шагов</p>
        <h1 className="hero-title">Время для важных разговоров</h1>
        <p className="hero-subtitle">
          Выберите удобный день и свободное время, чтобы записаться на звонок.
        </p>
        <Link to="/book" className="btn btn-accent hero-cta">
          Записаться на звонок
        </Link>
      </div>
      <section className="card hero-how" aria-labelledby="how-it-works">
        <h2 className="hero-how-title" id="how-it-works">
          Как это работает
        </h2>
        <ol className="hero-steps">
          {steps.map((step) => (
            <li key={step.title} className="hero-step">
              <span className="hero-step-icon" aria-hidden>
                <step.icon size={20} strokeWidth={2} />
              </span>
              <span>
                <span className="hero-step-title">{step.title}</span>
                <span className="hero-step-description">{step.description}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
