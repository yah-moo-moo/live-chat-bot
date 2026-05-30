import { AttachmentBuilder } from 'discord.js';
import db from './db.js';
import utils from './utils.js';

class Tagger {
    tagsPerEmbed = 25;
    apiClient = null;

    tags = [];
    guildId = null;
    streamStart = null;
    streamEnd = null;
    streamId = null;
    streamUrl = null;

    constructor(guildId, apiClient) {
        this.guildId = guildId;
        this.apiClient = apiClient;
        const config = db.getLatestStream(guildId);
        // stream is live if end time isn't set
        if (config && !config.streamEnd) {
            this.streamId = config.streamId;
            this.streamStart = config.streamStart;
            this.streamEnd = config.streamEnd;
            this.streamUrl = config.streamUrl;
            this.tags = db.getTags(guildId, this.streamId).map(tag => this.createProxy(tag));
        }
    }

    startStream(startEvent) {
        this.deleteTags();
        this.streamStart = startEvent.startDate;
        this.streamId = startEvent.id;
        this.streamUrl = null;
        this.streamEnd = null;

        setTimeout(() => {
            this.checkForVod(startEvent.broadcasterId, 0);
        }, 30 * 1000); // wait 30 seconds
    }

    endStream() {
        this.streamEnd = new Date();
        db.setStreamEndTime(this.streamId, this.streamEnd);
        this.streamId = null;
    }

    async setStreamUrl(url) {
        const video = await this.getVideo(url);

        if (video?.streamId) {
            if (this.streamUrl === video.url) {
                return utils.createEmbed(false, 'That is already the current VOD');
            }

            // handle existing stream if it exists
            if (this.streamId && this.streamId !== video.streamId) {
                db.moveTagsToNewStream(this.guildId, this.streamId, video.streamId);
                db.deleteStream(this.guildId, this.streamId);
            }
            
            this.createStream(video);
            return utils.createEmbed(true, `Stream ID: ${this.streamId}, Start: <t:${parseInt(this.streamStart / 1000, 10)}:f>`);
        } else {
            return utils.createEmbed(false, 'Couldn\'t find stream');
        }
    }

    async checkForVod(twitchUserId, retryCount) {
        try {
            const videos = await this.apiClient.videos.getVideosByUser(twitchUserId, {
                type: 'archive',
                limit: 1
            });
            if (videos.data.length !== 0) {
                const latestVideo = videos.data[0];
                console.log(`[${this.guildId}] Latest video ID:`, latestVideo.url);
                if (latestVideo.streamId === this.streamId) {
                    console.log(`[${this.guildId}] Matches current stream`);
                    this.createStream(latestVideo, true);
                    return;
                }
            }
        } catch (e) {
            console.error(`[${this.guildId}] Error checking for VOD:`, e);
        }
        
        if (retryCount < 5) {
            setTimeout(() => {
                this.checkForVod(twitchUserId, retryCount + 1);
            }, 2 * 60 * 1000); // wait 2 minutes
        }
    }

    async getVideo(url) {
        try {
            const videoId = url.split('/').pop().split('?')[0];
            return await this.apiClient.videos.getVideoById(videoId);
        } catch (e) {
            console.error(`[${this.guildId}] Error getting video:`, e);
        }
    }

    createStream(video, autoStart) {
        this.streamId = video.streamId;
        this.streamUrl = video.url;
        this.streamStart = video.creationDate;
        db.createStream(this);

        if (autoStart) {
            db.deleteOrphanedTags(this.guildId);
        } else {
            db.updateOrphanedTags(this.guildId, this.streamId);
        }
    }

    async createTag(message, content) {
        if (!content || content.length === 0) return;

        const tag = this.createProxy({
            authorId: message.author.id,
            messageId: message.id,
            message: content,
            createdAt: message.createdAt,
            time: new Date(message.createdAt.getTime() - (20 * 1000)),
            stars: 0,
            guildId: this.guildId,
            streamId: this.streamId,
            deleted: false
        });
        
        db.createTag(tag);
        await message.react('👍');
        await message.react('❌');
        this.tags.push(tag);
    }

    createProxy(tag) {
        return new Proxy(tag, {
            set(target, name, value) {
                if (name in target) {
                    target[name] = value;
                    db.updateTag(target.messageId, name, value);
                    return true;
                }
                return false;
            }
        });
    }

    adjustTime(message, offset) {
        const tag = this.tags.findLast(t => t.authorId === message.author.id);
        if (tag && offset) {
            offset = parseInt(offset.trim());
            if (isNaN(offset)) {
                message.react('❌');
                return;
            }
            const newTime = tag.time.getTime() + (offset * 1000);
            tag.time = new Date(newTime);
            if (this.streamStart && newTime < this.streamStart.getTime()) {
                tag.time = this.streamStart;
            };
            message.react('👍');
        }
    }

    addStar(messageId) {
        this.getTagByMessageId(messageId).stars++;
    }

    removeStar(messageId) {
        this.getTagByMessageId(messageId).stars--;
    }

    editTag(messageId, newMessage) {
        this.getTagByMessageId(messageId).message = newMessage;
    }

    deleteTag(messageId, userId) {
        const index = this.tags.findLastIndex(t => t.messageId === messageId);
        if (index >= 0) {
            if (!userId) {
                db.deleteTag(messageId);
                this.tags.splice(index, 1);
            } else if (this.tags[index].authorId === userId) {
                this.tags[index].deleted = true;
            }
        }
    }

    undeleteTag(messageId, userId) {
        const tag = this.getTagByMessageId(messageId);
        if (tag.authorId === userId) {
            tag.deleted = false;
        }
    }

    getTagByMessageId(messageId) {
        return this.tags.findLast(t => t.messageId === messageId) || {};
    }

    deleteTags() {
        this.tags = [];
        db.deleteMarkedTags(this.guildId);
        this.deleteStream();
        return utils.createEmbed(true, 'Tags deleted');
    }

    deleteStream() {
        this.streamId = null;
        this.streamUrl = null;
        this.streamStart = null;
        this.streamEnd = null;
    }

    async getTagsJson(args) {
        let vodLink = args?.vodLink;
        if (!vodLink) {
            const latestStream = db.getLatestStream(this.guildId);
            if (latestStream) {
                vodLink = latestStream.streamUrl;
            } else {
                return utils.createEmbed(false, 'No stream found');
            }
        }

        let { stream, tags } = await this.getStreamAndTags(vodLink);
        tags = tags.sort((a, b) => a.time - b.time);

        const attachment = new AttachmentBuilder(
            Buffer.from(JSON.stringify(tags, null, 4)),
            { name: `${stream.streamId}.json` }
        );
        return attachment;
    }

    async listTags(args) {
        const { vodLink, userId, display } = args || {};
        const { stream, tags } = await this.getStreamAndTags(vodLink);
        let tagList = tags.filter(tag => !tag.deleted);

        if (userId && display?.trim() !== 'all') {
            tagList = tagList.filter(tag => tag.authorId === userId);
        }
        tagList = tagList.sort((a, b) => a.time - b.time);

        if (!stream || tagList.length === 0) {
            return utils.createEmbed(false, 'No tags found');
        }
        
        const hours = this.calculateHours(stream.streamStart, stream.streamEnd);
        let tagInfo = `Stream start: <t:${parseInt(stream.streamStart / 1000, 10)}:f>, `;
        tagInfo += `${tagList.length} tags (${(tagList.length / hours).toFixed(1)}/hr)\n`;
        if (stream.streamUrl) {
            tagInfo += `Link: ${stream.streamUrl}\n`;
        }

        let firstEmbed = true,
            length = 0,
            lines = [];
        const embeds = [];
        
        for (let i = 0; i < tagList.length; i++) {
            const line = this.printTag(tagList[i], stream.streamUrl, stream.streamStart);
            lines.push(line);
            length += line.length;

            // make sure the description is under 4096
            if (lines.length === this.tagsPerEmbed ||
                i === tagList.length-1 ||
                length + tagList[i+1].message.length > 3900
            ) {
                const embed = {};
                let description = lines.join('');
                if (firstEmbed) {
                    description = tagInfo + description;
                    embed.title = 'Tags';
                    firstEmbed = false;
                }
                embed.description = description;
                embeds.push(embed);
                length = 0;
                lines = [];
            }
        }

        return embeds;
    }

    async getStreamAndTags(vodLink) {
        let stream, tags = [];
        if (vodLink) {
            const video = await this.getVideo(vodLink.trim());
            if (video?.streamId) {
                const dbStream = db.getStreamById(this.guildId, video.streamId);
                if (dbStream) {
                    stream = dbStream;
                    if (!stream.streamEnd && video.duration) {
                        stream.streamEnd = this.createStreamEnd(stream.streamStart, video.duration);
                        db.setStreamEndTime(stream.streamId, stream.streamEnd);
                    }
                    tags = db.getTags(this.guildId, video.streamId);
                }
            }
        } else {
            stream = { 
                streamStart: this.streamStart,
                streamEnd: this.streamEnd,
                streamUrl: this.streamUrl,
                streamId: this.streamId
            };
            tags = this.tags;
        }

        return { stream, tags };
    }

    getStreamUrl() {
        return this.streamUrl;
    }

    printTag(tag, url, streamStart) {
        let text = tag.message;
        if (tag.stars > 0) {
            text += ` (${tag.stars})`;
        }
        if (url) {
            const offset = this.calculateOffset(tag.time, streamStart);
            text += ` [${offset}](${url}?t=${offset})\n`;
        } else {
            text += ` ${offset}}\n`;
        }
        return text;
    }

    calculateHours(streamStart, streamEnd) {
        const start = streamStart;
        const end = streamEnd || new Date();
        const diffMs = end - start;
        return diffMs / (60 * 60 * 1000);
    }

    calculateOffset(time, streamStart) {
        const diffMs = time - streamStart;
        const sec = 1000, min = sec * 60, hr = min * 60;
        const diffSec = Math.floor((diffMs % min) / sec);
        const diffMin = Math.floor((diffMs % hr) / min);
        const diffHr = Math.floor(diffMs / hr);
        let timeString = '';
        if (diffHr > 0) {
            timeString += `${diffHr}h`;
        }
        if (!!timeString || diffMin > 0) {
            timeString += `${diffMin}m`;
        }
        timeString += `${diffSec}s`;
        return timeString;
    }

    createStreamEnd(start, duration) {
        const durationMs = this.isoDurationToMs(duration);
        return new Date(start.getTime() + durationMs);
    }

    isoDurationToMs(isoString) {
        const parts = isoString.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
        let seconds = 0;
        if (parts) {
            if (parts[1]) seconds += parseInt(parts[1], 10) * 60 * 60;
            if (parts[2]) seconds += parseInt(parts[2], 10) * 60;
            if (parts[3]) seconds += parseInt(parts[3], 10);
        }
        return seconds * 1000;
    }
};

export default Tagger;
