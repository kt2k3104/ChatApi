import { Module } from '@nestjs/common'
import { UserController } from './user.controller'
import { UserService } from './user.service'
import { MongooseModule } from '@nestjs/mongoose'
import { User, UserSchema } from './schemas/user.schema'
import { Key, KeySchema } from './schemas/key.schema'
import { CloudinaryModule } from '../cloudinary/cloudinary.module'
import { PusherModule } from 'src/pusher/pusher.module'

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Key.name, schema: KeySchema }
    ]),
    CloudinaryModule,
    PusherModule
  ],
  controllers: [UserController],
  providers: [UserService]
})
export class UserModule {}
