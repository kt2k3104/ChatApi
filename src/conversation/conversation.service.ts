import { BadRequestException, Injectable } from '@nestjs/common'
import { Model, Types } from 'mongoose'
import { InjectModel } from '@nestjs/mongoose'
import { Conversation } from './schemas/conversation.schema'
import { User, BASIC_INFO_SELECT } from 'src/user/schemas/user.schema'
import { ConversationTag, PusherService } from 'src/pusher/pusher.service'
import { Message, MessageTypes } from 'src/message/schemas/message.schema'
import { CloudinaryService, ImageType } from 'src/cloudinary/cloudinary.service'
import { CreateConvDto, UpdateInfoConvDto } from './dto'
import { MessageService } from 'src/message/message.service'

@Injectable()
export class ConversationService {
  constructor(
    @InjectModel(Conversation.name) private conversationModel: Model<Conversation>,
    @InjectModel(Message.name) private messageModel: Model<Message>,
    @InjectModel(User.name) private userModel: Model<User>,
    private pusherService: PusherService,
    private cloudinaryService: CloudinaryService,
    private messageService: MessageService
  ) {}

  async createConversation(userId: Types.ObjectId, createConvDto: CreateConvDto) {
    const { isGroup, members, name } = createConvDto

    if (isGroup && members.length < 2) {
      throw new BadRequestException('Invalid data')
    }

    if (isGroup) {
      let newGroupConversation = await this.conversationModel.create({
        name,
        admins: [userId],
        members: [...members, userId],
        isGroup,
        lastMessageAt: new Date()
      })

      newGroupConversation = await newGroupConversation.populate('members', BASIC_INFO_SELECT)

      newGroupConversation.members.forEach(member => {
        this.pusherService.trigger(
          member['_id'].toString(),
          'conversation:new',
          newGroupConversation
        )
      })

      return newGroupConversation
    }

    const friendId = members[0]

    const existingConversations = await this.conversationModel.find({
      $or: [
        {
          members: { $eq: [userId, friendId] }
        },
        {
          members: { $eq: [friendId, userId] }
        }
      ]
    })

    if (existingConversations.length > 0) {
      throw new BadRequestException('Conversation already exists')
    }

    let newSingleConversation = await this.conversationModel.create({
      name,
      admins: [userId, friendId],
      lastMessageAt: new Date(),
      members: [userId, friendId]
    })

    newSingleConversation = await newSingleConversation.populate('members', BASIC_INFO_SELECT)

    newSingleConversation.members.forEach(member => {
      this.pusherService.trigger(
        member['_id'].toString(),
        'conversation:new',
        newSingleConversation
      )
    })

    return newSingleConversation
  }

  async getConversationWithUserId(userId: Types.ObjectId) {
    const convIds = await this.conversationModel.find({
      members: { $in: [userId] }
    })

    const promises = convIds.map(convId => {
      return this.conversationModel
        .findOne({
          _id: convId['_id']
        })
        .populate([
          {
            path: 'members',
            select: BASIC_INFO_SELECT
          },
          {
            path: 'messages',
            options: {
              limit: 20,
              sort: { createdAt: -1 }
            },
            populate: [
              {
                path: 'sender',
                select: BASIC_INFO_SELECT
              },
              {
                path: 'seenUsers',
                select: BASIC_INFO_SELECT
              }
            ]
          }
        ])
        .sort({ lastMessageAt: -1 })
    })

    let conversations: Conversation[] = await Promise.all(promises)

    conversations = conversations.map(conversation => {
      if (conversation.hiddenUsers?.length > 0) {
        let newConversation = conversation
        conversation.hiddenUsers.forEach(hiddenUser => {
          if (hiddenUser.user['_id'].toString() === userId.toString()) {
            newConversation = {
              ...newConversation,
              messages: conversation.messages.filter(message => {
                return message['createdAt'] > hiddenUser['hiddenAt']
              })
            }
          }
        })
        return newConversation
      } else return conversation
    })

    return conversations
  }

  async getConversationWithId(userId: Types.ObjectId, conversationId: string) {
    const conversation = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        members: { $in: [userId] }
      })
      .populate([
        {
          path: 'members',
          select: BASIC_INFO_SELECT
        },
        {
          path: 'messages',
          options: {
            limit: 20,
            sort: { createdAt: -1 }
          },
          populate: [
            {
              path: 'sender',
              select: BASIC_INFO_SELECT
            },
            {
              path: 'seenUsers',
              select: BASIC_INFO_SELECT
            }
          ]
        }
      ])

    if (!conversation) {
      throw new BadRequestException('Invalid conversation or permission denied')
    }

    return conversation
  }

  async seenConversation(userId: Types.ObjectId, conversationId: string) {
    const conversation = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        members: { $in: [userId] }
      })
      .populate('members', BASIC_INFO_SELECT)
      .populate({
        path: 'messages',
        populate: {
          path: 'sender',
          select: BASIC_INFO_SELECT
        }
      })

    if (!conversation) {
      throw new BadRequestException('Invalid conversation')
    }

    const lastMessage = conversation.messages[conversation.messages.length - 1]

    if (!lastMessage) {
      return true
    }

    if (lastMessage.sender['_id'].toString() === userId.toString()) {
      return true
    }

    const hasSeen = lastMessage.seenUsers.some(seenUser => {
      return seenUser.toString() === userId.toString()
    })
    if (hasSeen) return true

    const updatedMessage = await this.messageModel
      .findOneAndUpdate({ _id: lastMessage['id'] }, { $push: { seenUsers: userId } }, { new: true })
      .populate('sender', BASIC_INFO_SELECT)
      .populate('seenUsers', BASIC_INFO_SELECT)
      .exec()

    this.pusherService.trigger(userId.toString(), 'conversation:update', {
      tag: ConversationTag.SEEN,
      conversationId,
      lastMessage: updatedMessage
    })

    this.pusherService.trigger(conversationId, 'message:update', {
      updatedMessage
    })

    return true
  }

  async updateThumb(conversationId: string, userId: Types.ObjectId, file: Express.Multer.File) {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      admins: { $in: [userId] }
    })

    if (!conversation) {
      throw new BadRequestException('Invalid conversation or permission denied')
    }

    if (!conversation.isGroup) {
      throw new BadRequestException('Invalid conversation')
    }

    const promises = []

    promises.push(this.cloudinaryService.uploadFile(file, ImageType.THUMB))

    if (conversation.thumb) {
      promises.push(this.cloudinaryService.destroyFile(conversation.thumb, ImageType.THUMB))
    }

    const result = await Promise.all(promises)

    await conversation.updateOne({
      thumb: result[0].secure_url
    })

    await this.messageService.createMessage(
      userId,
      { content: `Changed conversation thumb`, conversationId },
      null,
      MessageTypes.UP_THUMB
    )

    conversation.members.forEach(member => {
      this.pusherService.trigger(member.toString(), 'conversation:update', {
        tag: ConversationTag.UPDATE_THUMB,
        conversationId,
        imageUrl: result[0].secure_url
      })
    })
    return true
  }

  async updateInfo(
    conversationId: string,
    userId: Types.ObjectId,
    updateInfoConvDto: UpdateInfoConvDto
  ) {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      admins: { $in: [userId] }
    })

    if (!conversation) {
      throw new BadRequestException('Invalid conversation or permission denied')
    }

    if (!conversation.isGroup) {
      throw new BadRequestException('Invalid conversation')
    }

    await conversation.updateOne({
      name: updateInfoConvDto.name
    })

    await this.messageService.createMessage(
      userId,
      {
        content: `Changed conversation name to ${updateInfoConvDto.name}`,
        conversationId
      },
      null,
      MessageTypes.UP_INFO
    )

    conversation.members.forEach(member => {
      this.pusherService.trigger(member.toString(), 'conversation:update', {
        tag: ConversationTag.UPDATE_INFO,
        conversationId,
        updateInfo: updateInfoConvDto
      })
    })

    return true
  }

  async addMembers(conversationId: string, userId: Types.ObjectId, memberIds: string[]) {
    memberIds.forEach(memberId => {
      if (userId.toString() === memberId.toString()) {
        throw new BadRequestException('Invalid input')
      }
    })

    const conversation = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        admins: { $in: [userId] }
      })
      .populate('members', BASIC_INFO_SELECT)
      .populate({
        path: 'messages',
        populate: {
          path: 'sender',
          select: BASIC_INFO_SELECT
        },
        options: {
          limit: 20,
          sort: { createdAt: -1 }
        }
      })
      .lean()

    const members = await this.userModel
      .find({
        _id: { $in: memberIds.map(memberId => new Types.ObjectId(memberId)) }
      })
      .select(BASIC_INFO_SELECT)

    if (!conversation) {
      throw new BadRequestException('Invalid conversation or permission denied')
    }
    const oldMember = conversation.members.map(member => member['_id'].toString())

    if (!conversation.isGroup) {
      throw new BadRequestException('Invalid conversation')
    }

    const newMembers = [
      ...new Set([...conversation.members.map(member => member['_id'].toString()), ...memberIds])
    ]

    const numOfAddedMembers = newMembers.length - conversation.members.length

    if (numOfAddedMembers === 0) {
      throw new BadRequestException('Invalid input')
    }

    conversation.members = [...conversation.members, ...members]

    await this.conversationModel.updateOne(
      {
        _id: new Types.ObjectId(conversationId)
      },
      {
        $set: {
          members: newMembers.map(member => new Types.ObjectId(member))
        }
      }
    )

    const newMessage = await this.messageService.createMessage(
      userId,
      {
        content: `Added ${numOfAddedMembers} member(s)`,
        conversationId
      },
      null,
      MessageTypes.UP_ADD_MEMBER
    )
    conversation.messages.push(newMessage)

    memberIds.forEach(member => {
      this.pusherService.trigger(member, 'conversation:new', conversation)
    })

    oldMember.forEach(member => {
      this.pusherService.trigger(member, 'conversation:update', {
        tag: ConversationTag.ADD_MEMBERS,
        conversationId,
        members: conversation.members
      })
    })

    return conversation.members
  }

  async removeMembers(conversationId: string, userId: Types.ObjectId, memberId: string) {
    const conversation = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        admins: { $in: [userId] },
        members: { $in: [new Types.ObjectId(memberId)] }
      })
      .populate('members', BASIC_INFO_SELECT)

    const member = await this.userModel.findOne({ _id: new Types.ObjectId(memberId) })

    if (!conversation) {
      throw new BadRequestException('Invalid conversation or permission denied')
    }

    if (!conversation.isGroup) {
      throw new BadRequestException('Invalid conversation')
    }

    if (conversation.admins.some(admin => admin.toString() === memberId.toString())) {
      throw new BadRequestException('Cannot remove admin')
    }

    const newMembers = conversation.members.filter(member => {
      if (!(member['_id'].toString() !== memberId)) {
        this.pusherService.trigger(member['id'].toString(), 'conversation:update', {
          tag: ConversationTag.IS_LEAVE_CONVERSATION,
          conversationId
        })
      }

      return member['_id'].toString() !== memberId
    })

    const result = await conversation.updateOne({
      members: newMembers
    })

    if (result) {
      await this.messageService.createMessage(
        userId,
        {
          content: `Removed ${member.displayName}`,
          conversationId
        },
        null,
        MessageTypes.UP_RM_MEMBER
      )
    }

    newMembers.forEach(member => {
      this.pusherService.trigger(member['id'].toString(), 'conversation:update', {
        tag: ConversationTag.REMOVE_MEMBERS,
        conversationId,
        members: newMembers
      })
    })

    return newMembers
  }

  async leaveConversation(conversationId: string, userId: Types.ObjectId) {
    const conversation = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        members: { $in: [userId] }
      })
      .populate('members', BASIC_INFO_SELECT)

    if (!conversation) {
      throw new BadRequestException('Invalid conversation')
    }

    if (!conversation.isGroup) {
      throw new BadRequestException('Invalid conversation')
    }

    if (
      conversation.admins.length === 1 &&
      conversation.admins[0].toString() === userId.toString()
    ) {
      throw new BadRequestException('Cannot leave conversation')
    }

    const newMembers = conversation.members.filter(member => {
      if (!(member['id'].toString() !== userId.toString())) {
        this.pusherService.trigger(member['id'].toString(), 'conversation:update', {
          tag: ConversationTag.IS_LEAVE_CONVERSATION,
          conversationId
        })
      }

      return member['id'].toString() !== userId.toString()
    })

    const result = await conversation.updateOne({
      members: newMembers,
      $pull: {
        admins: userId
      }
    })

    if (result) {
      await this.messageService.createMessage(
        userId,
        {
          content: `Left conversation`,
          conversationId
        },
        null,
        MessageTypes.UP_LEAVE
      )
    }

    newMembers.forEach(member => {
      this.pusherService.trigger(member['id'].toString(), 'conversation:update', {
        tag: ConversationTag.LEAVE_CONVERSATION,
        conversationId,
        members: newMembers
      })
    })

    return newMembers
  }

  async addAdmins(conversationId: string, userId: Types.ObjectId, adminId: string) {
    if (userId.toString() === adminId.toString()) {
      throw new BadRequestException('Cannot add yourself')
    }

    const conversation = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        admins: { $in: [userId] },
        members: { $in: [new Types.ObjectId(adminId)] }
      })
      .populate('admins', BASIC_INFO_SELECT)

    const admin = await this.userModel
      .findOne({ _id: new Types.ObjectId(adminId) })
      .select(BASIC_INFO_SELECT)

    if (!conversation) {
      throw new BadRequestException('Invalid conversation or permission denied')
    }

    if (!conversation.isGroup) {
      throw new BadRequestException('Invalid conversation')
    }

    if (conversation.admins.some(admin => admin['_id'].toString() === adminId)) {
      throw new BadRequestException('User is already an admin')
    }

    await conversation.updateOne(
      {
        $push: {
          admins: new Types.ObjectId(adminId)
        }
      },
      { new: true }
    )

    await this.messageService.createMessage(
      userId,
      {
        content: `Added ${admin.displayName} to admin`,
        conversationId
      },
      null,
      MessageTypes.UP_ADD_ADMIN
    )

    conversation.members.forEach(member => {
      this.pusherService.trigger(member['_id'].toString(), 'conversation:update', {
        tag: ConversationTag.UPDATE_ADMINS,
        conversationId,
        admins: [...conversation.admins, admin]
      })
    })

    return [...conversation.admins, admin]
  }

  async getAllImages(conversationId: string, userId: Types.ObjectId) {
    const conversation = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        members: { $in: [userId] }
      })
      .populate('messages', '_id sender content images createdAt')
      .populate({
        path: 'messages',
        populate: {
          path: 'sender',
          select: BASIC_INFO_SELECT
        }
      })

    if (!conversation) {
      throw new BadRequestException('Invalid conversation or permission denied')
    }

    const images = conversation.messages.reduce((prev, message) => {
      if (message.images.length > 0) {
        message.images.forEach(image => {
          prev.push({
            messageId: message['_id'].toString(),
            sender: message.sender,
            image,
            createdAt: message['createdAt']
          })
        })
      }
      return prev
    }, [])

    return images
  }

  async getAllLinks(conversationId: string, userId: Types.ObjectId) {
    const regex = /(https?:\/\/[^\s]+)/g
    const conversation = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        members: { $in: [userId] }
      })
      .populate('messages', '_id sender content createdAt')
      .populate({
        path: 'messages',
        populate: {
          path: 'sender',
          select: BASIC_INFO_SELECT
        }
      })

    if (!conversation) {
      throw new BadRequestException('Invalid conversation or permission denied')
    }

    const links = conversation.messages.reduce((prev, message) => {
      const matches = message.content.match(regex)
      if (matches) {
        matches.forEach(match => {
          prev.push({
            messageId: message['_id'].toString(),
            sender: message.sender,
            link: match,
            createdAt: message['createdAt']
          })
        })
      }
      return prev
    }, [])

    return links
  }

  async search(userId: Types.ObjectId, keyword: string) {
    const conversations = this.conversationModel.find({
      $or: [
        {
          name: {
            $regex: keyword,
            $options: 'i'
          }
        }
      ],
      members: { $in: [userId] }
    })

    return conversations
  }

  async getNotSeenMessage(userId: Types.ObjectId) {
    const conversations = await this.conversationModel
      .find({
        members: { $in: [userId] }
      })
      .populate({
        path: 'messages',
        populate: {
          path: 'sender',
          select: BASIC_INFO_SELECT
        }
      })
      .populate({
        path: 'messages',
        populate: {
          path: 'seenUsers',
          select: BASIC_INFO_SELECT
        }
      })

    const notSeenMessages = conversations.reduce((prev, conversation) => {
      if (conversation.messages.length === 0) {
        return prev
      }

      const lastMessage = conversation.messages[conversation.messages.length - 1]
      if (!lastMessage) {
        return prev
      }

      if (lastMessage.sender['_id'].toString() === userId.toString()) {
        return prev
      }

      const hasSeen = lastMessage.seenUsers.some(seenUser => {
        return seenUser['_id'].toString() === userId.toString()
      })
      if (hasSeen) return prev

      prev.push(conversation._id)
      return prev
    }, [])

    return notSeenMessages
  }

  async leavePerConversation(conversationId: string, userId: Types.ObjectId, friendId: string) {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      members: { $in: [userId, friendId] }
    })

    if (!conversation) {
      throw new BadRequestException('Invalid conversation')
    }

    if (conversation.isGroup) {
      throw new BadRequestException('Invalid conversation')
    }

    // const newMembers = conversation.members.filter(member => {
    //   if (!(member['_id'].toString() !== userId.toString())) {
    //     this.pusherService.trigger(member['_id'].toString(), 'conversation:update', {
    //       tag: ConversationTag.IS_LEAVE_CONVERSATION,
    //       conversationId: conversation['_id'].toString()
    //     })
    //   }

    //   return member['_id'].toString() !== userId.toString()
    // })

    const newMembers = conversation.members.filter(member => {
      return member['_id'].toString() !== userId.toString()
    })
    const newAdmin = conversation.admins.filter(admin => {
      return admin['_id'].toString() !== userId.toString()
    })

    await conversation.updateOne({
      members: newMembers,
      admins: newAdmin
    })

    return true
  }

  async hiddenConversation(conversationId: string, userId: Types.ObjectId) {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      members: { $in: [userId] }
    })

    if (!conversation) {
      throw new BadRequestException('Invalid conversation')
    }

    const hiddenUser = conversation.hiddenUsers.find(user => {
      return user.user['_id'].toString() === userId.toString()
    })

    if (hiddenUser) {
      await conversation.updateOne({
        $set: {
          hiddenUsers: {
            user: userId,
            isHidden: true,
            hiddenAt: new Date()
          }
        }
      })
    } else {
      await conversation.updateOne({
        $push: {
          hiddenUsers: {
            user: userId
          }
        }
      })
    }

    return true
  }
}
