import Icon from './Icon.jsx';

// ---- App header (shared) --------------------------------------------------
export function Appbar({ title, large, sub, back, actions }) {
  if (large) {
    return (
      <div className="appbar lg">
        {(back || (actions && actions.length)) && (
          <div className="appbar-row">
            {back && <button className="iconbtn" onClick={back}><Icon icon="solar:arrow-left-linear" size={23} /></button>}
            <div style={{ flex: 1 }}></div>
            {actions && actions.map((a, i) => <button key={i} className="iconbtn ghost" onClick={a.onClick}><Icon icon={a.icon} size={23} /></button>)}
          </div>
        )}
        <div>
          <div className="title">{title}</div>
          {sub && <div style={{ fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 500, marginTop: 2 }}>{sub}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="appbar">
      {back && <button className="iconbtn" style={{ marginLeft: -8 }} onClick={back}><Icon icon="solar:arrow-left-linear" size={23} /></button>}
      <div className="rt-title" style={{ flex: 1, minWidth: 0 }}>
        <div className="title-sm">{title}</div>
        {sub && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
      </div>
      {actions && actions.map((a, i) => <button key={i} className="iconbtn ghost" onClick={a.onClick}><Icon icon={a.icon} size={23} /></button>)}
    </div>
  );
}

const TABS = [
  { id: 'library', label: 'Library', icon: 'solar:books-minimalistic-linear', iconOn: 'solar:books-minimalistic-bold' },
  { id: 'whatsnew', label: "What's New", icon: 'solar:bell-linear', iconOn: 'solar:bell-bold', badge: true },
  { id: 'discover', label: 'Discover', icon: 'solar:compass-linear', iconOn: 'solar:compass-bold' },
  { id: 'settings', label: 'Settings', icon: 'solar:settings-linear', iconOn: 'solar:settings-bold' },
];

export function BottomNav({ active, onTab }) {
  return (
    <div className="bottomnav">
      {TABS.map(t => (
        <button key={t.id} className={`navitem ${active === t.id ? 'active' : ''}`} onClick={() => onTab(t.id)}>
          <span className="navicon"><Icon icon={active === t.id ? t.iconOn : t.icon} size={25} /></span>
          {t.badge && active !== t.id && <span className="dot"></span>}
          <span className="navlabel">{t.label}</span>
        </button>
      ))}
    </div>
  );
}
