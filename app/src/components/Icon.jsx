import { Icon as Iconify } from '@iconify/react';

// Thin wrapper matching the prototype's <Icon icon size color/> API.
// Icon data is bundled offline in main.jsx via addCollection(solar).
export default function Icon({ icon, size = 22, color, style, cls }) {
  return (
    <Iconify
      icon={icon}
      className={cls}
      width={size}
      height={size}
      style={{ color, ...style }}
    />
  );
}
