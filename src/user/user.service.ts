import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { BASIC_INFO_SELECT, User, UserDocument } from './schemas/user.schema'
import { Model, Types } from 'mongoose'
import { InjectModel } from '@nestjs/mongoose'
import { AddFrienDto } from './dto/add-friend.dto'
import { FriendTag, PusherService } from 'src/pusher/pusher.service'
import { FriendIdDto } from './dto/friend-id.dto'

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    private pusherService: PusherService
  ) {}

  //get all user with mongoose
  async getAllUser(): Promise<any> {
    return await this.userModel
      .find()
      .populate('friends', BASIC_INFO_SELECT)
      .populate('friendRequests.sender', BASIC_INFO_SELECT)
      .populate('sentRequests.receiver', BASIC_INFO_SELECT)
  }

  async getCurrUser(userId: Types.ObjectId): Promise<any> {
    const user = await this.userModel
      .findById(userId)
      .populate('friends', BASIC_INFO_SELECT)
      .populate('friendRequests.sender', BASIC_INFO_SELECT)
      .populate('sentRequests.receiver', BASIC_INFO_SELECT)
      .lean()

    const allUser = await this.userModel.find().populate('friends', BASIC_INFO_SELECT)

    let strangers: any[] = allUser.filter(item => {
      return (
        item['_id'].toString() !== userId.toString() &&
        !user.friends.find(friend => friend['_id'].toString() === item['_id'].toString())
      )
    })

    strangers = strangers.map(item => {
      return {
        _id: item['_id'],
        email: item.email,
        firstName: item.firstName,
        lastName: item.lastName,
        avatar: item.avatar,
        displayName: item.displayName,
        isWaitingAccept: item.friendRequests.find(() => {
          return item.friendRequests.find(
            friendRequest => friendRequest.sender.toString() === userId.toString()
          )
        })
          ? true
          : false,
        mutualFriends: user.friends.filter(friend => {
          return item.friends.find(
            itemFriend => itemFriend['_id'].toString() === friend['_id'].toString()
          )
        })
      }
    })

    if (!user) {
      throw new NotFoundException('User not found')
    }

    return {
      ...user,
      strangers: strangers
    }
  }

  async getStrangres(userId: Types.ObjectId): Promise<any> {
    const user = await this.userModel.findById(userId).populate('friends', BASIC_INFO_SELECT).lean()

    const allUser = await this.userModel.find().populate('friends', BASIC_INFO_SELECT)

    if (!user) {
      throw new NotFoundException('User not found')
    }

    let strangers: any[] = allUser.filter(item => {
      return (
        item['_id'].toString() !== userId.toString() &&
        !user.friends.find(friend => friend['_id'].toString() === item['_id'].toString())
      )
    })

    strangers = strangers.map(item => {
      return {
        _id: item['_id'],
        displayName: item.displayName,
        email: item.email,
        firstName: item.firstName,
        lastName: item.lastName,
        avatar: item.avatar,
        isWaitingAccept: item.friendRequests.find(() => {
          return item.friendRequests.find(
            friendRequest => friendRequest.sender.toString() === userId.toString()
          )
        }),
        mutualFriends: user.friends.filter(friend => {
          return item.friends.find(
            itemFriend => itemFriend['_id'].toString() === friend['_id'].toString()
          )
        })
      }
    })

    return strangers
  }

  async updateAvatar(userId: Types.ObjectId, avatar: string): Promise<any> {
    return await this.userModel.updateOne({ _id: userId }, { avatar })
  }

  async search(query: string): Promise<any> {
    const promises = [
      this.userModel.find({
        $or: [
          {
            firstName: {
              $regex: query,
              $options: 'i'
            }
          }
        ]
      }),
      this.userModel.find({
        $or: [
          {
            email: {
              $regex: query,
              $options: 'i'
            }
          }
        ]
      })
    ]

    const result = await Promise.all(promises)

    const users = [...result[0], ...result[1]]

    return users.filter((user, index) => {
      return users.findIndex(item => item['_id'].toString() === user['_id'].toString()) === index
    })
  }

  async addFriend(user: UserDocument, addFriendto: AddFrienDto) {
    const { userId: friendId, message } = addFriendto

    if (user._id.toString() === friendId) {
      throw new BadRequestException('Invalid input')
    }

    const friend = await this.userModel.findById(friendId)

    if (!friend) {
      throw new NotFoundException('user not found')
    }

    user.friends.map(item => {
      if (item['_id'].toString() === friendId) {
        throw new BadRequestException('Friend already exists')
      }
    })

    user.friendRequests.map(item => {
      if (item.sender.toString() === friendId) {
        throw new BadRequestException('Friend request is pending acceptance')
      }
    })

    friend.friendRequests.map(item => {
      if (item.sender.toString() === user._id.toString()) {
        throw new BadRequestException('Friend request already sent')
      }
    })

    const friendRequests = {
      sender: user._id,
      message: message ? message : undefined,
      createdAt: Date.now()
    }

    const sentRequests = {
      receiver: friend._id,
      message: message ? message : undefined,
      createdAt: Date.now()
    }

    await friend.updateOne({
      $push: {
        friendRequests: friendRequests
      }
    })

    await user.updateOne({
      $push: {
        sentRequests: sentRequests
      }
    })

    // push event to friend
    this.pusherService.trigger(friendId, 'friend:request', {
      tag: FriendTag.ADD_FRIEND,
      userInfo: {
        sender: {
          _id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          displayName: user.displayName,
          avatar: user.avatar
        },
        message: 'Hello, I want to be your friend',
        createdAt: friendRequests.createdAt
      }
    })

    return {
      receiver: {
        _id: friend._id,
        firstName: friend.firstName,
        lastName: friend.lastName,
        email: friend.email,
        displayName: friend.displayName,
        avatar: friend.avatar
      },
      message: 'Hello, I want to be your friend',
      createAt: new Date(sentRequests.createdAt).toISOString()
    }
  }

  async acceptFriend(user: UserDocument, { userId: friendId }: FriendIdDto) {
    if (user._id.toString() === friendId) {
      throw new BadRequestException('Invalid input')
    }

    const friend = await this.userModel.findById(friendId)

    if (!friend) {
      throw new NotFoundException('user not found')
    }

    const friendRequest = user.friendRequests.find(item => item.sender.toString() === friendId)

    if (!friendRequest) {
      throw new BadRequestException('Friend request not found')
    }

    await user.updateOne({
      $push: {
        friends: friend._id
      },
      $pull: {
        friendRequests: {
          sender: friend._id
        }
      }
    })

    await friend.updateOne({
      $push: {
        friends: user._id
      },
      $pull: {
        sentRequests: {
          receiver: user._id
        }
      }
    })

    // push event to friend
    this.pusherService.trigger(friendId, 'friend:request', {
      tag: FriendTag.ACCEPT_FRIEND_REQUEST,
      newFriend: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        displayName: user.displayName,
        avatar: user.avatar
      }
    })

    return {
      _id: friend._id,
      firstName: friend.firstName,
      lastName: friend.lastName,
      avatar: friend.avatar
    }
  }

  async rejectFriendRequest(user: UserDocument, { userId: friendId }: FriendIdDto) {
    if (user._id.toString() === friendId) {
      throw new BadRequestException('Invalid input')
    }

    const friend = await this.userModel.findById(friendId)

    const friendRequest = user.friendRequests.find(item => item.sender.toString() === friendId)

    if (!friendRequest) {
      throw new BadRequestException('Friend request not found')
    }

    await user.updateOne({
      $pull: {
        friendRequests: {
          sender: new Types.ObjectId(friendId)
        }
      }
    })

    await friend.updateOne({
      $pull: {
        sentRequests: {
          receiver: user._id
        }
      }
    })

    return true
  }

  async cancelFriendRequest(user: UserDocument, { userId: friendId }: FriendIdDto) {
    if (user._id.toString() === friendId) {
      throw new BadRequestException('Invalid input')
    }

    const friend = await this.userModel.findById(friendId)

    if (!friend) {
      throw new NotFoundException('user not found')
    }

    const friendRequest = friend.friendRequests.find(
      item => item.sender.toString() === user._id.toString()
    )

    if (!friendRequest) {
      throw new BadRequestException('Friend request not found')
    }

    await friend.updateOne({
      $pull: {
        friendRequests: {
          sender: user._id
        }
      }
    })

    await user.updateOne({
      $pull: {
        sentRequests: {
          receiver: friend._id
        }
      }
    })

    this.pusherService.trigger(friendId, 'friend:request', {
      tag: FriendTag.CANCEL_FRIEND_REQUEST,
      friendId: user._id
    })

    return true
  }

  async removeFriend(user: UserDocument, { userId: friendId }: FriendIdDto) {
    if (user._id.toString() === friendId) {
      throw new BadRequestException('Invalid input')
    }

    const friend = await this.userModel.findById(friendId)

    if (!friend) {
      throw new NotFoundException('user not found')
    }

    const isFriend = user.friends.find(item => item['_id'].toString() === friendId)
    if (!isFriend) {
      throw new BadRequestException('Not friend')
    }

    await user.updateOne({
      $pull: {
        friends: friend._id
      }
    })

    await friend.updateOne({
      $pull: {
        friends: user._id
      }
    })

    return true
  }
}
