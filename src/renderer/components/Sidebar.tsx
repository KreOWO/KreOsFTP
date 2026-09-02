import { useMemo, useState } from 'react'
import { t } from '../../shared/i18n'
import type { ReactElement } from 'react'
import type { SiteSummary } from '@shared/types'
import { ConnectionTooltip } from './ConnectionTooltip'
import { IconPlug, IconPlus, IconRename, IconSearch, IconSettings, IconTrash } from './Icons'

interface SidebarProps {
  sites: SiteSummary[]
  activeSiteId: string | null
  busySiteId: string | null
  onConnect: (site: SiteSummary) => void
  onEdit: (site: SiteSummary) => void
  onDelete: (site: SiteSummary) => void
  onCreate: () => void
  onOpenSettings: () => void
}

function badgeClass(protocol: string): string {
  if (protocol === 'sftp') return 'site__badge site__badge--sftp'
  if (protocol.startsWith('ftps')) return 'site__badge site__badge--ftps'
  return 'site__badge'
}

function badgeText(protocol: string): string {
  if (protocol === 'sftp') return 'SFTP'
  if (protocol === 'ftps') return 'FTPS'
  if (protocol === 'ftps-implicit') return 'FTPS'
  return 'FTP'
}

export function Sidebar(props: SidebarProps): ReactElement {
  const { sites, activeSiteId, busySiteId, onConnect, onEdit, onDelete, onCreate, onOpenSettings } =
    props
  const [query, setQuery] = useState('')
  const [tooltip, setTooltip] = useState<{
    site: SiteSummary
    anchor: HTMLElement
    left: number
    top: number
  } | null>(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return sites
    return sites.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        s.host.toLowerCase().includes(needle) ||
        s.user.toLowerCase().includes(needle)
    )
  }, [sites, query])

  return (
    <>
    <aside className="sidebar">
      <div className="sidebar__head">
        <span className="sidebar__title">{t('Подключения')}</span>
        <button className="btn btn--ghost btn--icon" onClick={onCreate} title={t('Новое подключение')}>
          <IconPlus />
        </button>
      </div>

      {sites.length > 4 && (
        <div className="sidebar__search">
          <div style={{ position: 'relative' }}>
            <span
              style={{
                position: 'absolute',
                left: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-faint)',
                display: 'flex'
              }}
            >
              <IconSearch size={13} />
            </span>
            <input
              className="input"
              style={{ paddingLeft: 27, padding: '4px 8px 4px 27px' }}
              placeholder={t('Поиск…')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('Поиск подключения')}
            />
          </div>
        </div>
      )}

      <div className="sidebar__list">
        {filtered.length === 0 && (
          <div className="empty-note">
            {sites.length === 0 ? (
              <>
                
                {t('Пока нет сохранённых подключений.')}
                <br />
                
                {t('Нажмите')} <strong>+</strong>{t(', чтобы добавить сервер.')}
              </>
            ) : (
              t('Ничего не найдено')
            )}
          </div>
        )}

        {filtered.map((site) => (
          <div
            key={site.id}
            className={'site' + (site.id === activeSiteId ? ' site--selected' : '')}
            role="button"
            tabIndex={0}
            onDoubleClick={() => onConnect(site)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConnect(site)
            }}
            onMouseEnter={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setTooltip({
                site,
                anchor: event.currentTarget,
                left: Math.min(rect.right + 8, window.innerWidth - 292),
                top: Math.min(rect.top, window.innerHeight - 118)
              })
            }}
          >
            <span className={badgeClass(site.protocol)}>{badgeText(site.protocol)}</span>
            <span className="site__body">
              <span className="site__name">{site.name}</span>
            </span>
            <span className="site__actions">
              <button
                className="btn btn--ghost btn--icon"
                onClick={() => onConnect(site)}
                disabled={busySiteId === site.id}
                title={t('Подключиться')}
              >
                <IconPlug size={13} />
              </button>
              <button
                className="btn btn--ghost btn--icon"
                onClick={() => onEdit(site)}
                title={t('Изменить')}
              >
                <IconRename size={13} />
              </button>
              <button
                className="btn btn--ghost btn--icon"
                onClick={() => onDelete(site)}
                title={t('Удалить профиль')}
              >
                <IconTrash size={13} />
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        <button className="btn btn--block" onClick={onCreate}>
          <IconPlus size={13} />  {t('Новое подключение')}
        </button>
        <button className="btn btn--ghost btn--block" onClick={onOpenSettings}>
          <IconSettings size={13} />  {t('Настройки')}
        </button>
      </div>
    </aside>
    {tooltip && (
      <ConnectionTooltip
        anchor={tooltip.anchor}
        left={tooltip.left}
        top={tooltip.top}
        title={tooltip.site.name}
        endpoint={`${tooltip.site.user ? `${tooltip.site.user}@` : ''}${tooltip.site.host}:${tooltip.site.port}`}
        protocol={badgeText(tooltip.site.protocol)}
        onClose={() => setTooltip(null)}
      />
    )}
    </>
  )
}
