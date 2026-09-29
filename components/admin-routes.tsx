/**
 * The admin "Дороги" panel: every road of Tajikistan by number and name, with its US-style shield.
 * Search finds 'r303', 'Р-303', 'рб 4' or 'Памирский'; the editor changes a road's number and name
 * for the whole road at once (a live edit 'route/<route id>'), or returns the OpenStreetMap data.
 */
import {useEffect, useMemo, useState, type FormEvent} from 'react';
import {Check, Maximize2, Pencil, Search, Signpost, Undo2, X} from 'lucide-react';
import type {RoadEdit} from '@/lib/live-store';
import {isLabelled, refClass, routeTitle, type RoadRoute, type RouteClass, type RouteHw} from '@/lib/road-routes';
import type {RoadRoutesApi} from '@/lib/use-road-routes';
import './route-shield.css';

const HW_TITLE: Record<RouteHw, string> = {motorway: 'Автомагистраль', trunk: 'Магистраль', primary: 'Основная дорога', secondary: 'Второстепенная дорога', tertiary: 'Местная дорога', other: 'Проезд'};
const FILTERS = [['all', 'Все'], ['rb', 'РБ'], ['rj', 'РҶ'], ['local', 'Местные'], ['intl', 'Международные'], ['none', 'Без номера']] as const;
type Filter = typeof FILTERS[number][0];
const CLASS_ORDER: Record<RouteClass, number> = {rb: 0, rj: 1, local: 2, intl: 3, foreign: 4, none: 5};
const LIMIT = 150;
const collator = new Intl.Collator('ru', {numeric: true});
const km = (route: RoadRoute) => `${route.km.toLocaleString('ru-RU')} км`;
const matches = (filter: Filter, cls: RouteClass) => filter === 'all' || filter === cls || (filter === 'intl' && cls === 'foreign');

/** A road number as it looks on the map: blue with a red band for РБ, green for M/AH/E, white for РҶ and local roads. */
export function RouteShield({text, cls, small}: {text: string; cls: RouteClass; small?: boolean}) {
  return <span className={`route-shield ${cls}${small ? ' small' : ''}`} aria-label={cls === 'none' ? 'Без номера' : `Дорога ${text}`}>{cls === 'none' ? '—' : text}</span>;
}

export default function AdminRoutes({api, edits, selectedId, busy, onSelect, onSave, onReset}: {
  api: RoadRoutesApi
  edits: Record<string, RoadEdit>
  selectedId: string | null
  busy: boolean
  onSelect(id: string): void
  onSave(edit: RoadEdit): void | Promise<void>
  onReset(routeId: string): void | Promise<void>
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const route = selectedId ? api.byId.get(selectedId) ?? null : null;
  const [ref, setRef] = useState('');
  const [name, setName] = useState('');
  useEffect(() => {setRef(route?.ref ?? ''); setName(route?.name ?? '')}, [selectedId, route?.ref, route?.name]);

  const sorted = useMemo(() => api.routes.filter(isLabelled).sort((a, b) =>
    CLASS_ORDER[a.cls] - CLASS_ORDER[b.cls] || collator.compare(a.ref ?? '', b.ref ?? '') || collator.compare(a.name ?? '', b.name ?? '') || b.km - a.km), [api.routes]);
  const found = useMemo(() => (query.trim() ? api.find(query, 2000) : sorted).filter(item => matches(filter, item.cls)), [api, query, sorted, filter]);
  // Edits whose road is gone from a rebuilt data file. A kind of road whose file did not load
  // ('way:' strokes live in road-routes-extra.json) is not judged at all.
  const orphans = useMemo(() => {
    if (!api.ready) return [];
    const kinds = new Set([...api.base.keys()].map(key => key.split(':')[0]));
    return Object.values(edits).filter(edit => edit.roadId.startsWith('route/') && kinds.has(edit.roadId.slice(6).split(':')[0]) && !api.base.has(edit.roadId.slice(6)));
  }, [api.ready, api.base, edits]);

  if (selectedId) {
    if (!route) return <div className="admin-form"><p className="admin-empty">{api.ready ? 'Дорога не найдена. Данные могли обновиться — выберите её снова.' : 'Загружаем дороги…'}</p></div>;
    const saved = edits['route/' + route.id];
    const nextRef = ref.trim(), nextName = name.trim();
    const change: RoadEdit = {roadId: 'route/' + route.id, ...(nextRef !== (route.ref ?? '') ? {ref: nextRef} : {}), ...(nextName !== (route.name ?? '') ? {name: nextName} : {})};
    const changed = 'ref' in change || 'name' in change;
    const streets = [...new Set(route.ways.map(way => way.name).filter((value): value is string => !!value && value !== route.name))];
    const submit = (event: FormEvent) => {event.preventDefault(); if (changed) void onSave(change)};
    return <form className="admin-form" onSubmit={submit}>
      <div className="admin-routes-caption"><RouteShield text={nextRef || '—'} cls={nextRef ? refClass(nextRef) : 'none'}/><div><strong>{routeTitle({...route, ref: nextRef || null, name: nextName || null})}</strong><small>OpenStreetMap: {route.source.ref || 'без номера'} · {route.source.name || 'без названия'} · {route.ways.length.toLocaleString('ru-RU')} участков · {km(route)}</small></div></div>
      <label>Номер дороги<input value={ref} onChange={event => setRef(event.target.value)} maxLength={16} placeholder="например, R-303" autoComplete="off" spellCheck={false}/></label>
      <p className="admin-help">Пусто — номер на карте не показывается. {route.refs.length ? `Другие номера этой дороги: ${route.refs.join(', ')} — по ним её тоже можно найти.` : ''}</p>
      <label>Название дороги<input value={name} onChange={event => setName(event.target.value)} maxLength={160} placeholder="например, Памирский тракт" autoComplete="off"/></label>
      <p className="admin-help">Заменит название на участках без своего названия; городские улицы сохраняют свои названия.</p>
      {streets.length > 0 && <p className="admin-routes-streets">Улицы на этой дороге: {streets.slice(0, 8).join(', ')}{streets.length > 8 ? ` и ещё ${streets.length - 8}` : ''}. Их названия меняются во вкладке «Улицы».</p>}
      <div className="admin-routes-actions">
        <button className="admin-button primary" disabled={busy || !changed}><Check size={18}/>{busy ? 'Сохранение…' : 'Сохранить дорогу'}</button>
        <button type="button" className="admin-button" onClick={() => onSelect(route.id)}><Maximize2 size={16}/>Показать всю дорогу</button>
        {saved && <button type="button" className="admin-button" disabled={busy} onClick={() => void onReset(route.id)}><Undo2 size={16}/>Вернуть данные OpenStreetMap</button>}
      </div>
    </form>;
  }

  return <>
    <div className="admin-search"><Search size={18}/><input aria-label="Поиск дорог" placeholder="Номер или название дороги: R-303, РБ04, Памирский тракт" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" aria-label="Очистить поиск" onClick={() => setQuery('')}><X size={16}/></button>}</div>
    <div className="admin-review-filters admin-routes-filters" role="group" aria-label="Тип дороги">{FILTERS.map(([key, title]) => <button type="button" key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{title}</button>)}</div>
    <div className="admin-list">
      {found.slice(0, LIMIT).map(item => <button type="button" key={item.id} className="admin-list-item" onClick={() => onSelect(item.id)}>
        <RouteShield text={item.ref || '—'} cls={item.cls}/>
        <span><strong>{item.name || (item.ref ? `Дорога ${item.ref}` : item.ways.find(way => way.name)?.name || 'Дорога без номера')}</strong><small>{km(item)} · {HW_TITLE[item.hw]}{item.edited ? ' · изменено' : ''}</small></span>
        <Pencil size={15}/>
      </button>)}
      {found.length > LIMIT && <p className="admin-help">Показаны первые {LIMIT} из {found.length.toLocaleString('ru-RU')}. Уточните номер или название.</p>}
      {!found.length && <p className="admin-empty">{api.ready ? 'Ничего не найдено' : 'Загружаем дороги…'}</p>}
      <p className="admin-help"><Signpost size={14} style={{verticalAlign: '-2px', marginRight: 6}}/>Нажмите на дорогу на карте, чтобы присвоить номер даже безымянной дороге.</p>
    </div>
    {orphans.length > 0 && <div className="admin-routes-orphans"><strong>Правки без дороги</strong><p>После обновления данных OpenStreetMap эти дороги не найдены. Правку можно удалить.</p>
      {orphans.map(edit => <div className="admin-row" key={edit.roadId}><span>{[edit.ref, edit.name].filter(Boolean).join(' · ') || 'Скрытые номер и название'} <small>({edit.roadId.slice(6)})</small></span><button type="button" className="admin-button" disabled={busy} onClick={() => void onReset(edit.roadId.slice(6))}><Undo2 size={15}/>Удалить правку</button></div>)}
    </div>}
  </>;
}
