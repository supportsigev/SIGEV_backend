export const PAYMENT_SUPPORT_CATEGORY = 'Soporte de pago';

export const ATTACHMENT_CATEGORIES = [
  'Formato de requerimiento',
  'Cotizaciones presentadas',
  'Comunicado de aprobación',
  'Presupuesto final',
  'Facturas normalizadas',
  'Registro fotográfico',
  'Listado de asistencia',
] as const;

export const STATIC_FOLDERS = [
  'Formato de requerimiento',
  'Cotizaciones presentadas',
  'Comunicado de aprobación',
  'Presupuesto final',
] as const;

export const MODIFIABLE_FOLDERS = [
  'Facturas normalizadas',
  'Registro fotográfico',
  'Listado de asistencia',
] as const;

export const MULTI_DOCUMENT_FOLDERS = [
  ...MODIFIABLE_FOLDERS,
  'Cotizaciones presentadas',
] as const;

export const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.webm',
  '.avi',
] as const;

export const ALLOWED_EXTENSIONS = [
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.xlsx',
  '.xls',
  '.doc',
  '.docx',
  ...VIDEO_EXTENSIONS,
] as const;
