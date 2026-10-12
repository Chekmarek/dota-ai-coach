import { useEffect, useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { Card, NotImplemented, PageHeader } from '../components/ui';

export function VoiceSettings() {
  const { settings, update, error } = useSettings();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  // Только читаем список голосов Windows — сама озвучка подключается на этапе G
  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis?.getVoices() ?? []);
    load();
    window.speechSynthesis?.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load);
  }, []);

  if (!settings) return null;
  const v = settings.voice;

  return (
    <>
      <PageHeader title="Голос" subtitle="Озвучка рекомендаций локальным синтезатором речи." />
      <NotImplemented stage="этап G">
        Озвучка ещё не подключена — настройки ниже сохраняются, но пока ни на что не влияют.
      </NotImplemented>
      <Card title="Параметры">
        <div className="form">
          <label className="check">
            <input type="checkbox" checked={v.enabled} onChange={(e) => void update({ voice: { enabled: e.target.checked } })} />
            Включить речь
          </label>
          <label>
            Голос
            <select value={v.voiceId ?? ''} onChange={(e) => void update({ voice: { voiceId: e.target.value || null } })}>
              <option value="">Системный по умолчанию</option>
              {voices.map((x) => (
                <option key={x.voiceURI} value={x.voiceURI}>
                  {x.name} ({x.lang}){x.localService ? '' : ' — онлайн'}
                </option>
              ))}
            </select>
            <span className="muted small">Найдено голосов: {voices.length}. Онлайн-голоса использоваться не будут.</span>
          </label>
          <label>
            Скорость: {v.rate.toFixed(2)}×
            <input type="range" min={0.5} max={2} step={0.05} value={v.rate} onChange={(e) => void update({ voice: { rate: Number(e.target.value) } })} />
          </label>
          <label>
            Громкость: {Math.round(v.volume * 100)}%
            <input type="range" min={0} max={1} step={0.05} value={v.volume} onChange={(e) => void update({ voice: { volume: Number(e.target.value) } })} />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
      </Card>
    </>
  );
}
