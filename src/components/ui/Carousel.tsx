import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { prefersReducedMotion } from './motion';
import './Carousel.css';

export interface CarouselSlide {
  readonly id: string;
  /** 読み上げ用の短い名前（「残り 170」など）。 */
  readonly label: string;
  readonly content: ReactNode;
}

export interface CarouselProps {
  /** カルーセル全体の名前。 */
  readonly label: string;
  readonly slides: readonly CarouselSlide[];
  /** 自動送りの間隔。0 なら自動送りしない。 */
  readonly autoPlayMs?: number;
  readonly testId?: string;
}

/**
 * カルーセル（WAI-ARIA Carousel Pattern）。
 *
 * - 指でのスワイプは CSS scroll-snap にまかせる（慣性・端の跳ね返りが OS 標準になる）。
 * - 前後ボタン・ドット・矢印キーでも移動できる。
 * - 自動送りは、ホバー中・フォーカスが中にあるあいだ・停止ボタンを押したあとは止める。
 *   動きを減らす設定では最初から止めておく。
 * - 見えていないスライドは `inert` にし、Tab で隠れた中身へ入らないようにする。
 */
export function Carousel({ label, slides, autoPlayMs = 0, testId }: CarouselProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(() => autoPlayMs > 0 && !prefersReducedMotion());
  const [hold, setHold] = useState(false);
  const count = slides.length;

  const goTo = useCallback(
    (next: number) => {
      const target = (next + count) % count;
      setIndex(target);
      const track = trackRef.current;
      const slide = track?.children[target] as HTMLElement | undefined;
      if (track && slide && typeof track.scrollTo === 'function') {
        track.scrollTo({
          left: slide.offsetLeft - track.offsetLeft,
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
      }
    },
    [count],
  );

  // スワイプで位置が変わったら、いちばん近いスライドを現在地にする。
  const onScroll = () => {
    const track = trackRef.current;
    if (track === null || track.clientWidth === 0) return;
    const slideWidth = (track.children[0] as HTMLElement | undefined)?.offsetWidth ?? track.clientWidth;
    const nearest = Math.round(track.scrollLeft / Math.max(slideWidth, 1));
    if (nearest !== index && nearest >= 0 && nearest < count) setIndex(nearest);
  };

  const active = playing && !hold && count > 1;
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => goTo(index + 1), autoPlayMs);
    return () => window.clearTimeout(timer);
  }, [active, autoPlayMs, goTo, index]);

  if (count === 0) return null;

  return (
    <section
      className="carousel"
      aria-roledescription="carousel"
      aria-label={label}
      data-testid={testId}
      data-playing={active ? 'true' : 'false'}
      style={{ '--carousel-ms': `${autoPlayMs}ms` } as CSSProperties}
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHold(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          goTo(index + 1);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          goTo(index - 1);
        }
      }}
    >
      <div className="carousel__viewport">
        <div className="carousel__track" ref={trackRef} onScroll={onScroll} aria-live={active ? 'off' : 'polite'}>
          {slides.map((slide, slideIndex) => (
            <div
              key={slide.id}
              className="carousel__slide"
              role="group"
              aria-roledescription="slide"
              aria-label={`${slideIndex + 1} / ${count}: ${slide.label}`}
              data-active={slideIndex === index ? 'true' : 'false'}
              inert={slideIndex !== index}
            >
              {slide.content}
            </div>
          ))}
        </div>
      </div>

      <div className="carousel__controls">
        {autoPlayMs > 0 && (
          <button
            type="button"
            className="carousel__play"
            aria-label={playing ? '自動送りを止める' : '自動送りを再開する'}
            data-testid={testId ? `${testId}-play` : undefined}
            onClick={() => setPlaying((value) => !value)}
          >
            <span aria-hidden="true" data-icon={playing ? 'pause' : 'play'} />
          </button>
        )}
        <div className="carousel__dots">
          {slides.map((slide, slideIndex) => (
            <button
              key={slide.id}
              type="button"
              className="carousel__dot"
              aria-label={`${slideIndex + 1} 枚目: ${slide.label}`}
              aria-current={slideIndex === index ? 'true' : undefined}
              onClick={() => goTo(slideIndex)}
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="carousel__arrows">
          <button
            type="button"
            className="carousel__arrow carousel__arrow--prev"
            aria-label="前へ"
            data-testid={testId ? `${testId}-prev` : undefined}
            onClick={() => goTo(index - 1)}
          >
            <span aria-hidden="true" />
          </button>
          <button
            type="button"
            className="carousel__arrow carousel__arrow--next"
            aria-label="次へ"
            data-testid={testId ? `${testId}-next` : undefined}
            onClick={() => goTo(index + 1)}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
