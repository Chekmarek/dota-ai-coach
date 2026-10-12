import { NotImplemented, PageHeader } from '../components/ui';

export function MatchState() {
  return (
    <>
      <PageHeader title="Состояние матча" subtitle="Распознанные факты, ранее наблюдавшиеся значения, выводы и неизвестные." />
      <NotImplemented stage="этап D">
        Модель состояния матча ещё не создана. Здесь каждое значение будет показано с уверенностью, временем наблюдения и
        пометкой: «видно сейчас», «видели раньше», «вывод» или «неизвестно».
      </NotImplemented>
    </>
  );
}

export function RecommendationHistory() {
  return (
    <>
      <PageHeader title="История советов" subtitle="Все выданные и отозванные рекомендации с причинами." />
      <NotImplemented stage="этапы F и H">
        Рекомендаций пока нет: модуль решений и хранение истории в базе данных ещё не реализованы.
      </NotImplemented>
    </>
  );
}
