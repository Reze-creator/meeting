import type { CSSProperties } from 'react'

const paths = {
  video: 'M15 10l5-3v10l-5-3M4 6h9a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z',
  mic: 'M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3zM5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8',
  home: 'M3 10l9-7 9 7v10a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1z',
  users:
    'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM17 4a4 4 0 010 8M22 21v-2a4 4 0 00-3-3.87',
  chat: 'M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z',
  arrow: 'M5 12h14M12 5l7 7-7 7',
  plus: 'M12 5v14M5 12h14',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  check: 'M20 6L9 17l-5-5',
  close: 'M18 6L6 18M6 6l12 12',
  copy: 'M9 9h12v12H9zM5 15H3V3h12v2',
  settings:
    'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  clock: 'M12 8v5l3 2M22 12a10 10 0 11-20 0 10 10 0 0120 0z',
  shield: 'M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6',
  link: 'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-2 2M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l2-2',
  send: 'M22 2L9 15M22 2l-7 20-6-7-7-6z',
} as const

export type IconName = keyof typeof paths
export function Icon({
  name,
  size = 20,
  off = false,
  style,
}: {
  name: IconName
  size?: number
  off?: boolean
  style?: CSSProperties
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
      {off && <path d="M2 2l20 20" strokeWidth="2" />}
    </svg>
  )
}
