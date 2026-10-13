import { NotImplemented, PageHeader } from '../components/ui';

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
