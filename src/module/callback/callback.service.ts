import { Inject, Injectable } from "@nestjs/common";
import * as moment from "moment";
import * as uuid from "uuid/v4";
import { RedisService } from "nestjs-redis";
import { UserService } from "../users/user.service";
import { DeviceService } from "../device/device.service";
import { CreatAttributeDTO } from "../orbit/dto/attribute.dto";
import { CreateStrangerDTO } from "../stranger/dto/stranger.dto";
import { IDevice } from "../device/interfaces/device.interfaces";
import { OrbitService } from "../orbit/orbit.service";
import { StrangerService } from "../stranger/stranger.service";
import { CreateOrbitDTO } from "../orbit/dto/orbit.dto";
import { QiniuUtil } from "src/utils/qiniu.util";
import { IUser } from "../users/interfaces/user.interfaces";
import { MessageService } from "../message/message.service";
import { IOrbit } from "../orbit/interfaces/orbit.interfaces";
import { ResidentService } from "../resident/resident.service";
import { IResident } from "../resident/interfaces/resident.interfaces";
import { CreateOrbitMessageDTO } from "../message/dto/message.dto";
import { MediaGateway } from "../media/media.gateway";
import { ApplicationDTO } from "src/common/dto/Message.dto";
import { WeixinUtil } from "src/utils/weixin.util";
import { ZoneService } from "../zone/zone.service";
import { IZone } from "../zone/interfaces/zone.interfaces";
import { ZOCUtil } from "src/utils/zoc.util";
import { ConfigService } from "src/config/config.service";
import { IBlack } from "../black/interfaces/black.interfaces";
import { BlackService } from "../black/black.service";
import { IRole } from "../role/interfaces/role.interfaces";
import { RoleService } from "../role/role.service";
import { ISchool } from "../school/interfaces/school.interfaces";
import { SchoolService } from "../school/school.service";
import { SOCUtil } from "src/utils/soc.util";
import { CameraUtil } from "src/utils/camera.util";

interface IReceiver {
  id: string;
  type: string;
}

@Injectable()
export class CallbackService {
  constructor(
    @Inject(UserService) private readonly userService: UserService,
    @Inject(DeviceService) private readonly deviceService: DeviceService,
    @Inject(OrbitService) private readonly orbitService: OrbitService,
    @Inject(ResidentService) private readonly residentService: ResidentService,
    @Inject(SchoolService) private readonly schoolService: SchoolService,
    @Inject(MessageService) private readonly messageService: MessageService,
    @Inject(StrangerService) private readonly strangerService: StrangerService,
    @Inject(QiniuUtil) private readonly qiniuUtil: QiniuUtil,
    @Inject(WeixinUtil) private readonly weixinUtil: WeixinUtil,
    @Inject(ZOCUtil) private readonly zocUtil: ZOCUtil,
    @Inject(SOCUtil) private readonly socUtil: SOCUtil,
    @Inject(ZoneService) private readonly zoneService: ZoneService,
    @Inject(BlackService) private readonly blackService: BlackService,
    @Inject(RoleService) private readonly roleService: RoleService,
    readonly cameraUtil: CameraUtil,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly mediaWs: MediaGateway
  ) {}

  /**
   * 获取10位时间戳
   */
  getTemp(): string {
    let tmp = Date.now().toString();
    tmp = tmp.substr(0, 10);
    return tmp;
  }

  async callback(body: any) {
    const { Name } = body;
    let img: any = null;
    let imgex: any = null;
    let imgBase: any = null;
    let imgexBase: any = null;
    let deviceUUID: any = null;
    let mode;
    let userId;
    let Attribute: any = null;
    let profile: any = {};
    if (Name === "CompareInfo") {
      deviceUUID = body.DeviceUUID;
      imgBase = body.img;
      imgexBase = body.imgex;
      mode = body.WBMode;
      Attribute = body.Attribute;
      profile = {
        passTime: body.CaptureTime,
        compareResult: body.CompareResult,
        faceQuality: body.FaceQuality,
        faceFeature: body.FaceFeature,
        visitCount: body.VisitCount,
      };
      if (body.PicName) {
        userId = body.PicName.split("_")[1].replace(".jpg", "");
      }
    } else if (Name === "captureInfoRequest") {
      const { DeviceInfo, CaptureInfo, FaceInfo, CompareInfo } = body.Data;
      deviceUUID = DeviceInfo.DeviceUUID;
      imgBase = CaptureInfo.FacePicture;
      imgexBase = CaptureInfo.BackgroundPicture;
      mode = CompareInfo.PersonType;
      Attribute = CompareInfo.Attribute || {};
      profile = {
        passTime: CaptureInfo.CaptureTime,
        compareResult: CompareInfo.Similarity,
        faceQuality: FaceInfo.FaceQuality,
        faceFeature: null,
        visitCount: CompareInfo.VisitsCount,
      };

      if (mode !== 0) {
        userId = CompareInfo.PersonInfo.PersonId;
      }
    }
    if (deviceUUID === "umet8ei4ka5u") {
      console.log(body);
    }
    const device: IDevice | null = await this.deviceService.findByUUID(
      deviceUUID
    );
    if (!device) {
      return;
    }

    if (!imgBase) {
      return;
    }
    img = await this.qiniuUtil.uploadB64(imgBase);
    if (device.media && Number(mode) !== 2) {
      await this.mediaWs.sendMessage(String(device.media), {
        type: String(mode),
        imgUrl: img,
      });
    }
    if (imgexBase) {
      imgex = await this.qiniuUtil.uploadB64(imgexBase);
    }

    // const { Attribute } = body
    const attribute: CreatAttributeDTO = {
      age: Attribute.Age,
      gender: Attribute.Gender,
      glasses: Attribute.Glasses,
      mask: Attribute.Mask,
      race: Attribute.Race,
      beard: Attribute.Beard,
    };
    const stranger: CreateStrangerDTO = {
      device: device._id,
      zone: device.position._id,
      imgUrl: img,
      imgexUrl: imgex,
      attribute,
      ...profile,
    };
    if (profile.compareResult < 0.8) {
      mode = 0;
    }
    if (Number(mode) === 0) {
      await this.strangerService.create(stranger);
    } else if (Number(mode) === 2) {
      const client = this.redis.getClient();
      if (device.deviceType === 2) {
        await client.hincrby(this.config.LOG, this.config.LOG_OPEN, 1);
      }
      const user: IUser | null = await this.userService.updateById(userId, {});
      if (!user) {
        return;
      }
      let isZOCPush = false;
      let zipname = "";
      const resident = await this.residentService.findOneByCondition({
        user: userId,
        isDelete: false,
      });
      if (resident && device.position.zoneType === 1) {
        const owner = await this.userService.updateById(
          resident.address.owner,
          {}
        );

        if (owner && this.config.url === "https://xms.thinkthen.cn") {
          const zone: IZone = await this.zoneService.findById(resident.address);
          const time = moment().format("YYYYMMDDHHmmss");
          const zip = await this.zocUtil.genZip();
          const type = resident.type === "visitor" ? 2 : 1;
          const enrecord = await this.zocUtil.genEnRecord(
            zip,
            time,
            zone.profile,
            user,
            device,
            owner,
            imgBase,
            type
          );
          if (enrecord) {
            const data = await this.zocUtil.upload(zip, time);
            if (data.success) {
              isZOCPush = true;
              zipname = data.zipname;
              client.hincrby(this.config.LOG, this.config.LOG_ENRECORD, 1);
            }
          }
        }
      }

      const orbit: CreateOrbitDTO = {
        user: user._id,
        mode,
        isZOCPush,
        ZOCZip: zipname,
        ...stranger,
        upTime: Date.now(),
      };
      if (deviceUUID == "umet8ei4ka5u") {
        console.log(orbit, "orbit");
      }
      const createOrbit: IOrbit = await this.orbitService.create(orbit);
      await this.sendMessage(createOrbit, user, device);
    } else if (Number(mode) === 1) {
      const black: IBlack | null = await this.blackService.findById(userId);
      if (!black) {
        return;
      }
      const orbit: CreateOrbitDTO = { user: black._id, mode, ...stranger };
      const createOrbit: IOrbit = await this.orbitService.create(orbit);
      await this.sendBlackMessage(createOrbit, black, device);
    }
    return;
  }

  // 发送消息
  async sendMessage(orbit: IOrbit, user: IUser, device: IDevice) {
    const receivers: IReceiver[] = await this.receivers(user, device.zone);
    return await Promise.all(
      receivers.map(async (receiver) => {
        const receiverUser: IUser | null = await this.userService.findById(
          receiver.id
        );
        if (!receiverUser) {
          return;
        }
        const message: CreateOrbitMessageDTO = {
          sender: user._id,
          receiver: receiver.id,
          type: receiver.type,
          orbit: orbit._id,
          passType: device.passType,
          zone: device.zone,
          imgUrl: orbit.imgUrl,
          imgexUrl: orbit.imgexUrl,
          compareResult: orbit.compareResult,
          position: `${device.position.houseNumber}-${device.description}`,
        };
        await this.messageService.createOrbitMessage(message);
        let userType;
        switch (receiver.type) {
          case "family":
            userType = "家人";
            break;
          case "student":
            userType = "小孩";
            break;
          case "visitor":
            userType = "访客";
            break;
          default:
            break;
        }
        const application: ApplicationDTO = {
          first: {
            value: `您的${userType}${user.username}${
              device.passType === 1 ? "进入" : "离开"
            }了${device.position.houseNumber}-${device.description}`,
            color: "#173177",
          },
          keyword1: {
            value: userType,
            color: "#173177",
          },
          keyword2: {
            value: device.passType === 1 ? "进入" : "离开",
            color: "#173177",
          },
          keyword3: {
            value: user.username,
            color: "#173177",
          },
          keyword4: {
            value: moment().format("YYYY:MM:DD HH:mm:ss"),
            color: "#173177",
          },
          remark: {
            value: "详情可查看进出图像",
            color: "#173177",
          },
        };
        if (receiver.type === "student") {
          const client = this.redis.getClient();
          const exist = await client.get(`student_${receiverUser.openId}`);
          if (exist) {
            return;
          }
          // const middle = moment().startOf('d').add(12, 'hour')
          // const now = moment()
          // if (middle > now && device.passType === 2) {
          //   return
          // }
          // if (middle < now && device.passType === 1) {
          //   return
          // }
          await client.set(`student_${receiverUser.openId}`, 1, "EX", 60 * 40);
          this.weixinUtil.sendPassMessage(
            receiverUser.openId,
            application,
            "user"
          );
        } else {
          this.weixinUtil.sendPassMessage(
            receiverUser.openId,
            application,
            "user"
          );
        }
      })
    );
  }

  // 发送消息
  async sendBlackMessage(orbit: IOrbit, black: IBlack, device: IDevice) {
    const receivers: IReceiver[] = await this.roleService.blackReceivers(
      device
    );
    return await Promise.all(
      receivers.map(async (receiver) => {
        const receiverUser: IUser | null = await this.userService.findById(
          receiver.id
        );
        if (!receiverUser) {
          return;
        }
        const message: CreateOrbitMessageDTO = {
          sender: black._id,
          receiver: receiver.id,
          type: receiver.type,
          orbit: orbit._id,
          passType: device.passType,
          zone: device.zone,
          imgUrl: orbit.imgUrl,
          imgexUrl: orbit.imgexUrl,
          compareResult: orbit.compareResult,
          position: `${device.position.houseNumber}-${device.description}`,
        };
        await this.messageService.createOrbitMessage(message);
        const application: ApplicationDTO = {
          first: {
            value: `${device.position.houseNumber}-${device.description}有异常人员通过`,
            color: "#173177",
          },
          keyword1: {
            value: "异常人员",
            color: "#173177",
          },
          keyword2: {
            value: device.passType === 1 ? "进入" : "离开",
            color: "#173177",
          },
          keyword3: {
            value: black.username,
            color: "#173177",
          },
          keyword4: {
            value: moment().format("YYYY:MM:DD HH:mm:ss"),
            color: "#173177",
          },
          remark: {
            value: "详情可查看进出图像",
            color: "#173177",
          },
        };
        this.weixinUtil.sendPassMessage(
          receiverUser.openId,
          application,
          "black"
        );
      })
    );
  }

  // 发送消息
  async receivers(user: IUser, zone: string): Promise<IReceiver[]> {
    const receivers: IReceiver[] = [];
    const residents: IResident[] = await this.residentService.findByCondition({
      isDelete: false,
      user: user._id,
      checkResult: 2,
      isMonitor: true,
    });
    const schools: ISchool[] = await this.schoolService.findByCondition({
      isDelete: false,
      user: user._id,
      checkResult: 2,
      type: "student",
    });
    schools.map((school) => {
      school.parent.map((parent) => {
        receivers.push({ id: parent.user, type: "student" });
      });
    });
    await Promise.all(
      residents.map(async (resident) => {
        if (resident.type === "visitor") {
          await this.visitorReceivers(resident, zone, receivers);
          await this.residentService.updateById(resident._id, {
            isMonitor: false,
          });
        } else if (resident.type === "family" && resident.isMonitor) {
          await this.familyReceivers(user, resident, receivers);
        }
      })
    );
    return receivers;
  }

  // 访客推送人
  async visitorReceivers(
    resident: IResident,
    zone: string,
    receivers: IReceiver[]
  ): Promise<IReceiver[]> {
    const residents: IResident[] = await this.residentService.findByCondition({
      zone,
      isDelete: false,
      isPush: true,
      address: resident.address,
      checkResult: 2,
    });
    residents.map((resid) => {
      if (String(resid.user) === String(resident.user)) {
        return;
      }

      receivers.push({ id: resid.user, type: "visitor" });
      // await this.residentService.updateById(resid._id, { isMonitor: false })
    });

    return receivers;
  }

  // 访客推送人
  async familyReceivers(
    user: IUser,
    resident: IResident,
    receivers: IReceiver[]
  ): Promise<IReceiver[]> {
    const number = user.cardNumber;
    const thisYear = moment().format("YYYY");
    let age;
    if (number.length > 15) {
      const birthYear = number.slice(6, 10);
      age = Number(thisYear) - Number(birthYear);
    } else {
      const birthYear = `19${number.slice(6, 8)}`;
      age = Number(thisYear) - Number(birthYear);
    }
    if (age < 18 || age > 75) {
      const residents: IResident[] = await this.residentService.findByCondition(
        {
          isDelete: false,
          isPush: true,
          address: resident.address,
          checkResult: 2,
        }
      );
      residents.map((resid) => {
        if (String(resid.user) === String(resident.user)) {
          return;
        }
        receivers.push({ id: resid.user, type: "family" });
      });
    }
    return receivers;
  }
  // 心跳包处理
  async keepalive(body: any) {
    const { Name } = body;
    let uuid: string = "";
    if (Name === "KeepAlive") {
      const { DeviceUUID } = body;
      uuid = DeviceUUID;
    } else if (Name === "heartbeatRequest") {
      const { DeviceUUID } = body.Data.DeviceInfo;
      uuid = DeviceUUID;
    }
    const client = this.redis.getClient();
    const exist = await client.hget("device", uuid);
    if (!exist || Number(exist) > 3) {
      const device: IDevice | null = await this.deviceService.findByUUID(uuid);
      if (!device) {
        return;
      }
      if (await client.llen(`p2p_${device._id}`)) {
        await client.hset("p2p_pool", String(device._id), 1);
      }
      if (await client.llen(`p2pError_${device._id}`)) {
        await client.hset("p2pError_pool", String(device._id), 1);
      }
    }
    await client.hset("device", uuid, 1);
  }

  // 设备注册
  async register(body: any) {
    const { TimeStamp } = body;
    const session = `${uuid()}_${TimeStamp}`;
    const { DeviceUUID } = body.Data.DeviceInfo;
    await this.deviceService.updateSession(DeviceUUID, session);
    return {
      code: 1,
      data: {
        session,
      },
      message: "success",
      name: "registerResponse",
      timeStamp: TimeStamp,
    };

    // const client = this.redis.getClient()
    // const exist = await client.hget('device', DeviceUUID)
    // if (!exist || Number(exist) > 4) {
    //   const device: IDevice | null = await this.deviceService.findByUUID(DeviceUUID)
    //   if (!device) {
    //     return
    //   }
    //   await client.hset('p2p_pool', String(device._id), 1)
    //   await client.hset('p2pError_pool', String(device._id), 1)
    // }
    // await client.hset('device', DeviceUUID, 1)
  }

  // 上报设备
  // async upDeviceToZOC(code: string) {
  //   const devices: IDevice[] = await this.deviceService.findByZoneId(code)
  //   const zone = await this.zoneService.findById(code)
  //   const { detail, propertyCo } = zone
  //   await Promise.all(devices.map(async device => {
  //     const time = moment().format('YYYYMMDDHHmmss');
  //     const zip = await this.zocUtil.genZip()
  //     // await this.zocUtil.genResident(zip, time, residents)
  //     await this.zocUtil.genBasicAddr(zip, time, detail)
  //     await this.zocUtil.genManufacturer(zip, time)
  //     await this.zocUtil.genPropertyCo(zip, time, propertyCo, detail)
  //     await this.zocUtil.genDevice(zip, time, detail, device)
  //     const result = await this.zocUtil.upload(zip, time)
  //     if (result.success) {
  //       await this.deviceService.updateById(device._id, { isZOCPush: true, ZOCZip: result.zipname, upTime: Date.now() })
  //       const client = this.redis.getClient()
  //       await client.hincrby(this.config.LOG, this.config.LOG_DEVICE, 1)
  //     }
  //   }))
  // }

  // 上报人口zoc
  // async upResidentToZOC(zone: string) {
  //   const client = this.redis.getClient()
  //   const time = moment().format('YYYYMMDDHHmmss');
  //   const zip = await this.zocUtil.genZip()
  //   const residents: IResident[] = await this.residentService.findByCondition({
  //     zone,
  //     isZOCPush: null,
  //     checkResult: { $nin: [1, 3] },
  //     type: { $ne: 'visitor' },
  //   })
  //   const count = residents.length
  //   const devices: IDevice[] = await this.deviceService.findByCondition({ zone })
  //   const deviceIds = devices.map(device => String(device.deviceId))
  //   const zoneDetail: IZone = await this.zoneService.findById(zone)
  //   const { detail } = zoneDetail
  //   const residentDatas: any = []

  //   await Promise.all(residents.map(async resident => {
  //     const user: IUser | null = await this.userService.updateById(resident.user, {})
  //     const address: IZone = await this.zoneService.findById(resident.address)

  //     if (!user) {
  //       return
  //     }
  //     let phone = user.phone
  //     if (!phone) {
  //       const owner: IUser | null = await this.userService.findById(resident.reviewer)
  //       if (!owner) {
  //         return
  //       }
  //       phone = owner.phone
  //     }
  //     const zocData = await this.zocUtil.genResidentData(address.profile, detail, user, deviceIds, phone)
  //     residentDatas.push(zocData)

  //   }))
  //   await this.zocUtil.genResident(zip, time, residentDatas)
  //   const zocResult = await this.zocUtil.upload(zip, time)
  //   if (zocResult.success) {
  //     await this.residentService.updateMany({ zone, checkResult: 2, isDelete: false }, { isZOCPush: true, ZOCZip: zocResult.zipname, upTime: Date.now() })
  //     client.hincrby(this.config.LOG, this.config.LOG_RESIDENT, count)
  //   }

  // return data
  // }
  // 上报人口soc
  // async upResidentToSOC(zone: string) {
  //   const client = this.redis.getClient()
  //   const residents: IResident[] = await this.residentService.findByCondition({ zone, checkResult: { $in: [2, 4, 5] }, isDelete: false })
  //   const count = residents.length
  //   const socDatas: any = []
  //   await Promise.all(residents.map(async resident => {
  //     const user: IUser | null = await this.userService.updateById(resident.user, {})
  //     const address: IZone = await this.zoneService.findById(resident.address)
  //     const reviewer: IUser | null = await this.userService.updateById(resident.reviewer, {})
  //     const zone: IZone = await this.zoneService.findById(resident.zone)
  //     if (!user || !reviewer || !user.cardNumber) {
  //       return
  //     }
  //     let phone = user.phone
  //     if (!phone) {
  //       const owner: IUser | null = await this.userService.findById(resident.reviewer)
  //       if (!owner) {
  //         return
  //       }
  //       phone = owner.phone
  //     }

  //     const socData = await this.socUtil.genResidentData(address.profile.dzbm, user, phone, reviewer, zone.detail)
  //     await this.residentService.updateById(resident._id, { SOCOrder: socData.lv_sbxxlsh })
  //     socDatas.push(socData)

  //   }))
  //   const socResult = await this.socUtil.upload(socDatas)
  //   if (socResult) {
  //     await this.residentService.updateMany({ zone, checkResult: 2, isDelete: false }, { isSOCPush: true })
  //     client.hincrby(this.config.LOG, this.config.LOG_SOC, count)
  //   }
  // }

  async testEnrecord(id) {
    const orbit: IOrbit | null = await this.orbitService.findById(id);
    if (!orbit) {
      return;
    }
    const device = await this.deviceService.findById(orbit.device);
    const user: IUser | null = await this.userService.updateById(
      orbit.user,
      {}
    );
    if (!user) {
      return;
    }
    const imgBase = await this.cameraUtil.getImg(orbit.imgUrl);
    const resident = await this.residentService.findOneByCondition({
      user: user._id,
      isDelete: false,
    });
    if (resident) {
      const owner = await this.userService.updateById(
        resident.address.owner,
        {}
      );

      if (owner) {
        const zone: IZone = await this.zoneService.findById(resident.address);
        const time = moment().format("YYYYMMDDHHmmss");
        const zip = await this.zocUtil.genZip();
        const type = resident.type === "visitor" ? 2 : 1;
        await this.zocUtil.genEnRecord(
          zip,
          time,
          zone.profile,
          user,
          device,
          owner,
          imgBase,
          type
        );
        const result = await this.zocUtil.upload(zip, time);
        console.log(result, "upResult");
      }
    }
  }

  async testDevice() {
    const devices = await this.deviceService.findByCondition({});
    await Promise.all(
      devices.map(async (device) => {
        const position: IZone = await this.zoneService.findById(
          device.position
        );
        const zone: IZone = await this.zoneService.findById(device.zone);
        if (zone.zoneType === 2) {
          return;
        }
        const zones: string[] = await this.deviceService.getZones(position);
        const time = moment().format("YYYYMMDDHHmmss");
        const zip = await this.zocUtil.genZip();
        await this.zocUtil.genManufacturer(zip, time);
        await this.zocUtil.genDevice(
          zip,
          time,
          position,
          zone.detail,
          device,
          zones
        );
        const result = await this.zocUtil.upload(zip, time);
        if (result.success) {
          await this.deviceService.updateById(device._id, {
            isZOCPush: true,
            ZOCZip: result.zipname,
            upTime: Date.now(),
          });
        }
        console.log(result, "upResult");
      })
    );
  }

  sleep = function(delay) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(1);
        } catch (e) {
          reject(0);
        }
      }, delay);
    });
  };

  async reUpdateResident() {
    const residents = await this.residentService.findByCondition({
      isDelete: false,
      type: { $ne: "visitor" },
      zone: "5dd762b15a793eb1c0d62a33",
    });
    let i = 0;
    // let t = 0
    const result: any = [];
    console.log(residents.length, "aa");
    for (let resident of residents) {
      // if (resident.upTime && resident.isZOCPush && moment(resident.upTime).format('YYYY-MM-DD HH:mm:ss') > '2020-01-03 12:20:00') {
      //   console.log(t)
      //   t += 1
      //   continue
      // }
      await this.sleep(200);
      console.log("start.......:", i);
      const data = await this.testResident(resident._id, i);
      result.push(data);
      i += 1;
    }
    return result;
  }

  async testResident(id: string, count: number) {
    const resident = await this.residentService.findById(id);
    const zone = await this.zoneService.findById(resident.address);
    const user = await this.userService.updateById(resident.user, {});
    if (!user || !user.cardNumber) {
      return;
    }
    const zoneIds = [...zone.ancestor, zone._id];
    const devices: IDevice[] = await this.deviceService.findByCondition({
      position: { $in: zoneIds },
      enable: true,
    });
    let phone = user.phone;
    if (!phone) {
      const owner = await this.userService.findById(zone.owner);
      if (!owner) {
        return;
      }
      phone = owner.phone;
    }
    const deviceIds = devices.map((device) => String(device.deviceId));
    const data = await this.zocUtil.genResidentData(
      zone.profile,
      user,
      deviceIds,
      phone,
      user.faceUrl
    );
    const time = moment().format("YYYYMMDDHHmmss");
    const zip = await this.zocUtil.genZip();
    await this.zocUtil.genResident(zip, time, [data]);
    const result = await this.zocUtil.upload(zip, time);
    console.log(result, "result");
    if (result.success) {
      const client = this.redis.getClient();
      client.hincrby(this.config.LOG, this.config.LOG_RESIDENT, 1);
      await this.residentService.findByIdAndUpdate(id, {
        isZOCPush: true,
        ZOCZip: result.zipname,
        upTime: Date.now(),
      });
    }

    console.log("end.....:", count);
    return result.zipname;
  }

  async testProCo(id) {
    const zone = await this.zoneService.findById(id);
    const time = moment().format("YYYYMMDDHHmmss");
    const zip = await this.zocUtil.genZip();
    await this.zocUtil.genPropertyCo(zip, time, zone.propertyCo, zone.detail);
    const result: any = await this.zocUtil.upload(zip, time);
    console.log(result, "upResult");
  }
}
