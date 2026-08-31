import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { EventWithRelations } from '../../database/types';
import { CreateEventDto, UpdateEventDto, ChangeStatusDto } from './dto';
import { EventStateMachine } from './state-machine';
import { ItemsService } from '../items/items.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EVENT_STATUS, ROLES } from '../../config/constants';
import { MODIFIABLE_FOLDERS } from '../attachments/attachments-folders';

const eventInclude = {
  items: {
    where: { isActive: true },
    include: { paymentItems: { select: { id: true } } },
  },
  attachments: true,
  createdBy: true,
  disbursement: true,
  selectedQuotation: { include: { ally: true } },
  quotations: {
    where: { isActive: true },
    include: {
      ally: true,
      items: { where: { isActive: true }, select: { itemId: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  ofertaEconomica: {
    include: { items: { orderBy: { createdAt: 'asc' as const } } },
  },
} as const;

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly itemsService: ItemsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private roleNames(roles: { name: string }[]): string[] {
    return roles.map((role) => role.name);
  }

  private isOperator(user: { roles: { name: string }[] }): boolean {
    return this.roleNames(user.roles).includes(ROLES.OPERATOR);
  }

  private normalizeSuffix(suffix?: string): string {
    return (suffix ?? '').trim().toUpperCase();
  }

  private async assertUniqueCodeSuffix(
    code: string,
    suffix: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.event.findFirst({
      where: {
        code,
        suffix,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'El número de evento con ese sufijo ya existe',
      );
    }
  }

  private async resolveMunicipality(dto: {
    divipolaCode?: string;
    municipalityName?: string;
    municipalityCategory?: string;
  }): Promise<{ divipolaCode?: string; municipalityName?: string; municipalityCategory?: string }> {
    if (dto.divipolaCode && !dto.municipalityCategory) {
      const municipality = await this.prisma.municipality.findUnique({
        where: { divipolaCode: dto.divipolaCode },
      });
      if (municipality) {
        return {
          divipolaCode: municipality.divipolaCode,
          municipalityName: dto.municipalityName ?? municipality.name,
          municipalityCategory: municipality.category,
        };
      }
    }
    return {
      divipolaCode: dto.divipolaCode,
      municipalityName: dto.municipalityName,
      municipalityCategory: dto.municipalityCategory,
    };
  }

  private async assertDisbursementActive(disbursementId?: string): Promise<void> {
    if (!disbursementId) return;
    const disbursement = await this.prisma.disbursement.findUnique({
      where: { id: disbursementId },
      select: { isActive: true },
    });
    if (!disbursement) {
      throw new BadRequestException('El recurso disponible asignado no existe');
    }
    if (!disbursement.isActive) {
      throw new BadRequestException('El recurso disponible asignado está inactivo');
    }
  }

  private assertExecutionSupportDocuments(
    event: { attachments: { category: string | null }[] },
    targetStatus: string,
  ): void {
    const loadedFolders = new Set(
      (event.attachments ?? [])
        .map((att) => att.category)
        .filter((category): category is string => !!category),
    );
    const missing = (MODIFIABLE_FOLDERS as readonly string[]).filter(
      (folder) => !loadedFolders.has(folder),
    );
    if (missing.length) {
      throw new BadRequestException(
        `Para pasar el evento a "${targetStatus}" cada una de las carpetas de soportes documentales debe contar con al menos un documento. Faltan documentos en: ${missing.join(', ')}.`,
      );
    }
  }

  async create(
    dto: CreateEventDto,
    user: { id: string; roles: { name: string }[] },
  ): Promise<EventWithRelations> {
    const suffix = this.normalizeSuffix(dto.suffix);
    await this.assertUniqueCodeSuffix(dto.code, suffix);

    const roles = this.roleNames(user.roles);
    const isSolicitante = roles.includes(ROLES.SOLICITANTE);

    if (isSolicitante && dto.items?.length) {
      throw new ForbiddenException(
        'El Solicitante no carga ítems al crear la orden; la asociación de ítems tarifados y no tarifados se realiza sobre la orden ya creada',
      );
    }

    if (dto.schemaType === 'detalle' && dto.items?.length) {
      throw new BadRequestException(
        'El esquema Detalle no admite ítems al crear la orden; los asocia el Solicitante sobre la orden ya creada',
      );
    }

    const initialStatus = EVENT_STATUS.ABIERTO;

    const municipality = await this.resolveMunicipality(dto);
    await this.assertDisbursementActive(dto.disbursementId);

    return this.prisma.$transaction(async (tx) => {
      const savedEvent = await tx.event.create({
        data: {
          code: dto.code,
          suffix,
          schemaType: dto.schemaType ?? 'cotizacion',
          name: dto.name,
          description: dto.description,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          dependency: dto.dependency ?? null,
          hamlet: dto.hamlet ?? null,
          attendees: dto.attendees ?? 0,
          days: dto.days ?? 0,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          divipolaCode: municipality.divipolaCode,
          municipalityName: municipality.municipalityName,
          municipalityCategory: municipality.municipalityCategory,
          generalAllyId: dto.generalAllyId || null,
          disbursementId: dto.disbursementId || null,
          createdById: user.id,
          status: initialStatus,
          programa: dto.programa ?? null,
          instanciaParticipacion: dto.instanciaParticipacion ?? null,
        },
      });

      if (dto.items?.length) {
        const event = {
          id: savedEvent.id,
          municipalityCategory: savedEvent.municipalityCategory,
          startDate: savedEvent.startDate,
        };
        const items: Prisma.ItemUncheckedCreateInput[] = [];
        for (const itemDto of dto.items) {
          items.push(await this.itemsService.buildItemData(itemDto, event));
        }
        await tx.item.createMany({ data: items });
      }

      return tx.event.findUniqueOrThrow({
        where: { id: savedEvent.id },
        include: eventInclude,
      });
    });
  }

  async findAll(
    user?: { id?: string; allyId?: string | null; roles: { name: string }[] },
    options?: { includeDeleted?: boolean },
  ): Promise<EventWithRelations[]> {
    const where: Prisma.EventWhereInput = {};

    if (options?.includeDeleted) {
      const roles = user ? this.roleNames(user.roles) : [];
      if (!roles.includes(ROLES.FUNCTIONAL_ADMIN)) {
        throw new ForbiddenException(
          'Solo el Admin. Funcional puede consultar órdenes anuladas',
        );
      }
    } else {
      where.deletedAt = null;
    }

    if (user && this.roleNames(user.roles).includes(ROLES.SOLICITANTE) && user.id) {
      where.createdById = user.id;
    }

    return this.prisma.event.findMany({
      where,
      include: eventInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(
    id: string,
    user?: { allyId?: string | null; roles: { name: string }[] },
  ): Promise<EventWithRelations> {
    const event = await this.prisma.event.findFirst({
      where: { id, deletedAt: null },
      include: eventInclude,
    });
    if (!event) throw new NotFoundException('Evento no encontrado');
    return event;
  }

  async update(
    id: string,
    dto: UpdateEventDto,
    user: { id: string; allyId?: string | null; roles: { name: string }[] },
  ): Promise<EventWithRelations> {
    const event = await this.findOne(id, user);
    const roles = this.roleNames(user.roles);

    if (event.status === EVENT_STATUS.RECHAZADO) {
      throw new ForbiddenException(
        'La orden fue rechazada y su proceso está detenido; no se puede modificar',
      );
    }

    const isEditor = roles.some((role) =>
      [ROLES.FUNCTIONAL_ADMIN, ROLES.SUPERVISOR].includes(role as never),
    );
    const isAnalista = roles.includes(ROLES.ANALISTA);
    const isSolicitante = roles.includes(ROLES.SOLICITANTE);

    if (this.isOperator(user)) {
      throw new ForbiddenException(
        'El Operador ya no gestiona ítems ni edita órdenes; la asociación de ítems tarifados y no tarifados corresponde al Solicitante',
      );
    }

    if (!isEditor && !isAnalista && !isSolicitante) {
      throw new ForbiddenException('Su perfil no puede editar eventos');
    }

    if (isAnalista && event.status !== EVENT_STATUS.DEVUELTO) {
      throw new ForbiddenException(
        'El Analista solo puede ajustar eventos devueltos por el Aprobador',
      );
    }

    if (isSolicitante) {
      const estadoPermitido =
        event.status === EVENT_STATUS.ABIERTO ||
        event.status === EVENT_STATUS.EN_EJECUCION ||
        event.status === EVENT_STATUS.DEVUELTO;
      if (!estadoPermitido) {
        throw new ForbiddenException(
          'El Solicitante solo puede editar la orden en estado Abierto, En ejecución o Devuelto',
        );
      }
      if (event.createdById && event.createdById !== user.id) {
        throw new ForbiddenException(
          'El Solicitante solo puede gestionar ítems de las órdenes que creó',
        );
      }
    }

    const { items, ...data } = dto as UpdateEventDto & { items?: CreateEventDto['items'] };

    const hasApprovedQuotation = !!event.cotizacionSeleccionadaId;

    if (items && hasApprovedQuotation && !isSolicitante) {
      throw new BadRequestException(
        'La cotización del evento ya fue aprobada; no se pueden realizar modificaciones.',
      );
    }

    const municipality = await this.resolveMunicipality(data);
    await this.assertDisbursementActive(dto.disbursementId);

    const nextSuffix = dto.suffix !== undefined ? this.normalizeSuffix(dto.suffix) : event.suffix ?? '';
    const nextCode = dto.code ?? event.code;
    await this.assertUniqueCodeSuffix(nextCode, nextSuffix, id);

    return this.prisma.$transaction(async (tx) => {
      await tx.event.update({
        where: { id },
        data: {
          ...municipality,
          code: nextCode,
          name: dto.name !== undefined ? dto.name : undefined,
          description: dto.description !== undefined ? dto.description : undefined,
          schemaType: dto.schemaType !== undefined ? dto.schemaType : undefined,
          suffix: nextSuffix,
          disbursementId: dto.disbursementId ?? event.disbursementId,
          startDate:
            dto.startDate !== undefined
              ? (dto.startDate ? new Date(dto.startDate) : null)
              : undefined,
          dependency: dto.dependency !== undefined ? (dto.dependency || null) : undefined,
          hamlet: dto.hamlet !== undefined ? (dto.hamlet || null) : undefined,
          attendees: dto.attendees,
          days: dto.days,
          latitude: dto.latitude !== undefined ? dto.latitude : undefined,
          longitude: dto.longitude !== undefined ? dto.longitude : undefined,
          programa: dto.programa !== undefined ? (dto.programa || null) : undefined,
          instanciaParticipacion: dto.instanciaParticipacion !== undefined ? (dto.instanciaParticipacion || null) : undefined,
        },
      });

      if (items && (isEditor || isAnalista || isSolicitante)) {
        const eventContext = {
          id,
          municipalityCategory: municipality.municipalityCategory ?? event.municipalityCategory,
          startDate:
            dto.startDate !== undefined
              ? (dto.startDate ? new Date(dto.startDate) : null)
              : event.startDate,
        };

        const quotationLockedItemIds = new Set<string>();
        if (event.cotizacionSeleccionadaId) {
          const approvedQuotationItems = await tx.quotationItem.findMany({
            where: { quotationId: event.cotizacionSeleccionadaId, itemId: { not: null } },
            select: { itemId: true },
          });
          for (const qi of approvedQuotationItems) {
            if (qi.itemId) quotationLockedItemIds.add(qi.itemId);
          }
        }

        const existingItems = await tx.item.findMany({
          where: { eventId: id },
          select: {
            id: true,
            name: true,
            description: true,
            unitMeasure: true,
            quantity: true,
            unitPrice: true,
            tariffId: true,
            isTariffed: true,
            allyId: true,
            paymentItems: { select: { id: true } },
          },
        });
        const existingIds = new Set(existingItems.map((existing) => existing.id));

        const isLocked = (existing: (typeof existingItems)[number]) =>
          quotationLockedItemIds.has(existing.id) || existing.paymentItems.length > 0;

        const sameValues = (
          itemDto: NonNullable<CreateEventDto['items']>[number],
          existing: (typeof existingItems)[number],
        ): boolean => {
          const incomingDescription = (itemDto.description ?? '').trim();
          const currentDescription = (existing.description ?? '').trim();
          const sameDescription =
            incomingDescription === currentDescription ||
            (currentDescription === '' && incomingDescription === (existing.name ?? '').trim());
          return (
            (itemDto.name ?? null) === existing.name &&
            sameDescription &&
            (itemDto.unitMeasure ?? null) === (existing.unitMeasure ?? null) &&
            Number(itemDto.quantity) === existing.quantity &&
            (itemDto.unitPrice === undefined ||
              Number(itemDto.unitPrice) === Number(existing.unitPrice)) &&
            (itemDto.tariffId ?? null) === (existing.tariffId ?? null) &&
            (itemDto.isTariffed === undefined || itemDto.isTariffed === existing.isTariffed) &&
            (itemDto.allyId ?? null) === (existing.allyId ?? null)
          );
        };

        const incomingIds = new Set(
          items
            .filter((itemDto) => itemDto.id && existingIds.has(itemDto.id))
            .map((itemDto) => itemDto.id as string),
        );

        for (const itemDto of items) {
          if (!itemDto.id || !existingIds.has(itemDto.id)) continue;
          const existing = existingItems.find((e) => e.id === itemDto.id);
          if (existing && isLocked(existing) && !sameValues(itemDto, existing)) {
            throw new BadRequestException(
              'No se puede modificar el ítem porque ya fue pagado o está asociado a una cotización aprobada',
            );
          }
        }

        for (const itemDto of items) {
          if (itemDto.id && existingIds.has(itemDto.id)) {
            const existing = existingItems.find((e) => e.id === itemDto.id);
            if (existing && isLocked(existing)) continue;
            const updateData = await this.itemsService.buildItemData(itemDto, eventContext);
            await tx.item.update({
              where: { id: itemDto.id },
              data: updateData,
            });
          }
        }

        const toCreate = items.filter(
          (itemDto) => !itemDto.id || !existingIds.has(itemDto.id),
        );
        if (toCreate.length) {
          const itemData: Prisma.ItemUncheckedCreateInput[] = [];
          for (const itemDto of toCreate) {
            itemData.push(await this.itemsService.buildItemData(itemDto, eventContext));
          }
          await tx.item.createMany({ data: itemData });
        }

        for (const existing of existingItems) {
          if (incomingIds.has(existing.id)) continue;
          if (isLocked(existing)) {
            throw new BadRequestException(
              'No se puede eliminar el ítem porque ya fue pagado o está asociado a una cotización aprobada',
            );
          }
          await tx.item.delete({ where: { id: existing.id } });
        }
      }

      return tx.event.findUniqueOrThrow({
        where: { id },
        include: eventInclude,
      });
    });
  }

  async changeStatus(
    id: string,
    dto: ChangeStatusDto,
    user: { id: string; allyId?: string | null; roles: { name: string }[] },
  ): Promise<EventWithRelations> {
    const event = await this.findOne(id, user);
    const roles = this.roleNames(user.roles);

    const quotationsCount = event.quotations?.length || 0;
    const itemsCount = event.items?.length || 0;
    const leavingDevuelto = event.status === EVENT_STATUS.DEVUELTO;
    const originDevuelto =
      event.devueltoDesde ??
      (event.devolucionLegalizacion ? EVENT_STATUS.CERRADO : null);
    EventStateMachine.canTransition(event.status, dto.status, roles, {
      quotationsCount,
      itemsCount,
      authorizeException: dto.authorizeException,
      devueltoDesde: leavingDevuelto ? originDevuelto : undefined,
    });

    const hasDefinitiveQuotation =
      (event.quotations?.some((q) => q.isDefinitive) ?? false) ||
      !!event.cotizacionSeleccionadaId;
    const isRechazo = dto.status === EVENT_STATUS.RECHAZADO;
    const isDevolucionInicial =
      dto.status === EVENT_STATUS.DEVUELTO && event.status === EVENT_STATUS.ABIERTO;

    if (isRechazo && !dto.observation?.trim()) {
      throw new BadRequestException(
        'Debe indicar el motivo u observación del rechazo de la orden',
      );
    }

    if (!isRechazo) {
      if (isDevolucionInicial) {
        if (quotationsCount < 1) {
          throw new BadRequestException(
            'La orden debe contar con al menos una cotización para devolverla a ajustes',
          );
        }
      } else if (
        leavingDevuelto &&
        originDevuelto === EVENT_STATUS.ABIERTO
      ) {
        // Regla de oro: retorno de la devolución al estado Abierto, no exige cotización definitiva
      } else if (!hasDefinitiveQuotation) {
        throw new BadRequestException(
          'La orden debe contar con al menos una cotización aprobada de forma definitiva antes de cambiar su estado',
        );
      }
    }

    if (
      event.status === EVENT_STATUS.EN_EJECUCION &&
      dto.status === EVENT_STATUS.EJECUTADO
    ) {
      this.assertExecutionSupportDocuments(event, dto.status);
    }

    if (
      leavingDevuelto &&
      originDevuelto &&
      originDevuelto !== EVENT_STATUS.ABIERTO
    ) {
      this.assertExecutionSupportDocuments(event, dto.status);
    }

    if (dto.status === EVENT_STATUS.CERRADO && quotationsCount < 1) {
      throw new BadRequestException(
        'Para cerrar el evento se requiere al menos una cotización registrada.',
      );
    }

    if (dto.status === EVENT_STATUS.CERRADO && !event.disbursementId) {
      throw new BadRequestException(
        'El evento debe tener un recurso disponible asignado antes de cerrar',
      );
    }
    await this.assertDisbursementActive(event.disbursementId ?? undefined);

    const data: {
      status: string;
      observation?: string;
      authorizeException?: boolean;
      devolucionLegalizacion?: boolean;
      devueltoDesde?: string | null;
    } = {
      status: dto.status,
      devolucionLegalizacion:
        dto.status === EVENT_STATUS.DEVUELTO
          ? event.status === EVENT_STATUS.CERRADO
          : false,
      devueltoDesde:
        dto.status === EVENT_STATUS.DEVUELTO ? event.status : null,
    };
    if (dto.observation) data.observation = dto.observation;
    if (dto.authorizeException) data.authorizeException = true;

    const updated = await this.prisma.event.update({
      where: { id },
      data,
      include: eventInclude,
    });

    if (isRechazo || dto.status === EVENT_STATUS.DEVUELTO) {
      const operatorIds = await this.notificationsService.findOperatorUserIdsForAlly(
        event.generalAllyId,
      );
      const type = isRechazo ? 'EVENT_REJECTED' : 'EVENT_RETURNED';
      const message =
        (isRechazo
          ? `La orden ${event.code} fue rechazada. `
          : `La orden ${event.code} fue devuelta para ajustes. `) +
        (dto.observation ? `Motivo: ${dto.observation}` : '');
      await this.notificationsService.createMany([event.createdById, ...operatorIds], {
        eventId: event.id,
        type,
        message,
      });
    }

    return updated;
  }

  async remove(
    id: string,
    user: { allyId?: string | null; roles: { name: string }[] },
  ): Promise<void> {
    const event = await this.findOne(id, user);
    if (event.status === EVENT_STATUS.RECHAZADO) {
      throw new ForbiddenException(
        'La orden fue rechazada y su proceso está detenido; no se puede eliminar',
      );
    }
    await this.prisma.event.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async restore(
    id: string,
    user: { allyId?: string | null; roles: { name: string }[] },
  ): Promise<EventWithRelations> {
    const event = await this.prisma.event.findFirst({ where: { id } });
    if (!event) throw new NotFoundException('Evento no encontrado');
    if (!event.deletedAt) {
      throw new BadRequestException(
        'La orden no está anulada; no requiere restauración',
      );
    }
    await this.assertUniqueCodeSuffix(
      event.code,
      this.normalizeSuffix(event.suffix ?? ''),
      id,
    );
    await this.prisma.event.update({
      where: { id },
      data: { deletedAt: null, isActive: true },
    });
    return this.prisma.event.findUniqueOrThrow({
      where: { id },
      include: eventInclude,
    });
  }
}
