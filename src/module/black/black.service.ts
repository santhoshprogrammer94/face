import { Model } from 'mongoose';
import { Inject, Injectable } from '@nestjs/common';
import { IBlack } from './interfaces/black.interfaces';
import { CreateBlackDTO, BlackDTO } from './dto/black.dto';
import { ApiErrorCode } from 'src/common/enum/api-error-code.enum';
import { ApiException } from 'src/common/expection/api.exception';
import { Pagination } from 'src/common/dto/pagination.dto';
import { IList } from 'src/common/interface/list.interface';
import { CameraUtil } from 'src/utils/camera.util';
import { RoleService } from '../role/role.service';
import { DeviceService } from '../device/device.service';
import { IDevice } from '../device/interfaces/device.interfaces';
import { ConfigService } from 'src/config/config.service';
import { FaceService } from '../face/face.service';
import { IUser } from '../users/interfaces/user.interfaces';
import { UserService } from '../users/user.service';
import { RedisService } from 'nestjs-redis';
import { IZone } from '../zone/interfaces/zone.interfaces';
import { IRole } from '../role/interfaces/role.interfaces';
import { IFace } from '../face/interfaces/face.interfaces';

@Injectable()
export class BlackService {
  constructor(
    @Inject('BlackModelToken') private readonly blackModel: Model<IBlack>,
    @Inject(CameraUtil) private readonly cameraUtil: CameraUtil,
    @Inject(RoleService) private readonly roleService: RoleService,
    @Inject(DeviceService) private readonly deviceService: DeviceService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(FaceService) private readonly faceService: FaceService,
    @Inject(UserService) private readonly userService: UserService,
    private readonly redis: RedisService,
  ) {

  }
  async addToZone(user: string, zone: IZone, createBlack: CreateBlackDTO): Promise<IBlack> {
    const canActive = await this.roleService.checkRoles({ isDelete: false, role: { $in: [1, 5] }, user, zone })
    if (!canActive) {
      throw new ApiException('无权限', ApiErrorCode.NO_PERMISSION, 403);
    }

    const black: BlackDTO = {
      ...createBlack,
      applicant: user,
      applicationTime: new Date(),
      checkResult: 1,
      zone: zone._id,
      area: zone.area,
    }
    return await this.blackModel.create(black);
  }

  async add(user: string, createBlack: CreateBlackDTO) {
    const role = await this.roleService.findOneByCondition({ isDelete: false, role: 4, user })
    if (!role) {
      throw new ApiException('无权限', ApiErrorCode.NO_PERMISSION, 403);
    }
    const black: BlackDTO = {
      ...createBlack,
      applicant: user,
      applicationTime: new Date(),
      checkResult: 1,
      area: role.area
      // zone,
    }
    // console.log(black, 'black')
    const newBlack = await this.blackModel.create(black);
    await this.agree(newBlack._id, user)
  }


  // 查询全部数据
  async getTail(skip: number, zone: string, user: string): Promise<IBlack | null> {
    const canActive = await this.roleService.checkRoles({ isDelete: false, role: 1, user, zone })
    if (!canActive) {
      throw new ApiException('无权限', ApiErrorCode.NO_PERMISSION, 403);
    }
    const condition: any = {
      zone,
      isDelete: false,
    };
    const list = await this.blackModel
      .find(condition)
      .sort({ role: 1 })
      .limit(1)
      .skip(skip - 1)
      .sort({ applicationTime: -1 })
      .populate({ path: 'applicant', model: 'user' })
      .populate({ path: 'zone', model: 'zone' })
      .lean()
      .exec();
    if (list.length) {
      return list[0]
    } else {
      return null
    }

  }

  // 查询全部数据
  async findAll(pagination: Pagination, type: number, user: string): Promise<IList<IBlack>> {
    const role: IRole | null = await this.roleService.findOneByCondition({ user, isDelete: false, role: 4 })
    if (!role) {
      throw new ApiException('无权限', ApiErrorCode.NO_PERMISSION, 403);
    }
    let checkResult: any = type
    if (checkResult === 2) {
      checkResult = { $in: [2, 4, 5] }
    }
    const condition: any = { checkResult, isDelete: false, area: role.area };
    const list = await this.blackModel
      .find(condition)
      .limit(pagination.limit)
      .skip((pagination.offset - 1) * pagination.limit)
      .sort({ applicationTime: -1 })
      .populate({ path: 'applicant', model: 'user' })
      .populate({ path: 'zone', model: 'zone' })
      .lean()
      .exec();
    const total = await this.blackModel.countDocuments(condition);
    return { list, total };
  }

  // 黑名单列表
  async findByZone(pagination: Pagination, zone: string, user: string): Promise<IList<IBlack>> {
    const canActive = await this.roleService.checkRoles({ isDelete: false, role: { $in: [1, 5] }, user, zone })
    if (!canActive) {
      throw new ApiException('无权限', ApiErrorCode.NO_PERMISSION, 403);
    }
    const condition: any = {
      zone,
      isDelete: false,
    };
    const list = await this.blackModel
      .find(condition)
      .limit(pagination.limit)
      .skip((pagination.offset - 1) * pagination.limit)
      .sort({ checkResult: 1 })
      .lean()
      .exec();
    const total = await this.blackModel.countDocuments(condition);
    return { list, total };
  }

  async findByCondition(condition: any) {
    return await this.blackModel.find(condition)
    // .populate({ path: 'zone', model: 'zone' }).lean().exec()
  }

  // 根据id查询
  async findById(id: string): Promise<IBlack | null> {
    return await this.blackModel
      .findById(id)
      .populate({ path: 'applicant', model: 'user' })
      .populate({ path: 'zone', model: 'zone' })
      .lean()
      .lean()
      .exec();
  }

  // 接受黑名单申请
  async agree(id: string, userId: string) {
    const black: IBlack = await this.blackModel
      .findById(id)
      .lean()
      .exec()
    const devices: IDevice[] = await this.deviceService.findByAreaId(black.area)
    const user: IUser | null = await this.userService.findById(userId);
    if (!user) {
      return
    }
    devices.map(async device => {
      const face = {
        device: device._id,
        user: black._id,
        mode: this.config.blackMode,
        bondToObjectId: black._id,
        bondType: 'black',
        zone: black.zone,
        checkResult: 1,
        faceUrl: black.faceUrl
      }
      const createFace = await this.faceService.create(face)
      return await this.faceService.addOnePic(createFace, device, black, this.config.blackMode, black.faceUrl)
    })
    const checkResult = await this.faceService.checkResult(id)
    await this.blackModel.findByIdAndUpdate(id, {
      checkResult,
      checkTime: new Date(),
      reviewer: userId,
    })
    const client = this.redis.getClient()
    client.hincrby(this.config.LOG, this.config.LOG_BLACK, 1)
    return true;
  }

  // 黑名单审核不通过
  async reject(id: string, reviewer: string): Promise<boolean> {
    await this.blackModel.findByIdAndUpdate(id, {
      checkResult: 3,
      checkTime: new Date(),
      reviewer,
    })
    return true;
  }

  // 根据id修改
  async updateById(id: string, update: any): Promise<IBlack | null> {
    return await this.blackModel.findByIdAndUpdate(id, update)
  }

  //删除黑名单
  async deleteById(id: string) {
    const faces: IFace[] = await this.faceService.findByCondition({ bondToObjectId: id, isDelete: false })
    await Promise.all(faces.map(async face => {
      await this.faceService.delete(face)
    }))
    await this.blackModel.findByIdAndUpdate(id, { isDelete: true })
  }
}