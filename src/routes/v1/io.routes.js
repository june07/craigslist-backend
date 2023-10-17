const { v5: uuidv5 } = require('uuid')

const redis = require('../../config/redis')
const logger = require('../../config/logger')
const { crawlerService } = require('../../components/crawler')
const { githubService } = require('../../components/github')
const { contactController } = require('../../components/contact')
const { alertController } = require('../../components/alert')
const { addContactToDailyList } = require('../../common/services/mail.service')

const namespace = 'clippings-backend:routes:io'

function router(io) {
    logger.info({ namespace, message: 'Setting up io routes...' })
    const mainNamespace = io.of('/').on('connection', socket => {
        const clientId = `${socket.request.headers['x-forward-for']}_${socket.sessionId}`

        socket.on('updateContact', async (params) => {
            contactController.updateContact(params, socket)
        })
        .on('deleteContact', async (params) => {
            contactController.deleteContact(params, socket)
        })
        .on('setEmergencyAlert', async (params) => {
            alertController.setEmergencyAlert(params, socket)
        })
        .on('clearEmergencyAlert', async (id) => {

        })
        .on('getArchive', async (listingPid, callback) => {
            if (!listingPid.match(/\d{10}/)?.[0]) {
                callback(new Error('invalid pid'))
                return
            }
            let archive = await redis.HGET('archives', listingPid)

            if (!archive) {
                // get it from mongoose and maybe move it back to archives or a different cache?!
                archive = await redis.HGET('archives-older', listingPid)
            }
            callback(archive)
        })
        .on('archive', async (listingURL) => {
            const listingUUID = uuidv5(listingURL, uuidv5.URL)
            const listingPid = listingURL.match(/\/([^\/]*)\.htm/)[1]
            if (!listingPid) {
                return new Error('invalid pid')
            }
            // check to see if it's been done already
            const archive = await redis.HGET('archives', listingPid)
            if (archive) {
                socket.emit('update', { archived: JSON.parse(archive) })
                return
            }

            socket.craigslist = { listingPid, listingURL, listingUUID, clientId }

            const { emitter } = await crawlerService.archive(socket.craigslist)
            emitter.on('archived', async payload => {
                socket.emit('update', payload)
                const mostRecentListings = await redis.SMEMBERS('recent_listings')
                mainNamespace.emit('mostRecentListings', mostRecentListings)
            })
        }).on('getMostRecentListings', async (callback) => {
            const mostRecentListings = await redis.SMEMBERS('recent_listings')
            callback(mostRecentListings)
        }).on('getMostRecentDiscussions', async (options) => {
            const { last } = options

            const commentData = await githubService.getCommentData({ last })
            const archiveData = await redis.HMGET('archives', commentData.map(discussion => discussion.title))
            const data = commentData.map((discussion, index) => {
                if (archiveData[index] && JSON.parse(archiveData[index])?.url) {
                    return { ...discussion, url: JSON.parse(archiveData[index]).url }
                } else {
                    return discussion
                }
            })
            mainNamespace.emit('mostRecentDiscussions', data)
        }).on('updateDiscussion', async (giscusDiscussion) => {
            const { id, totalCommentCount } = giscusDiscussion

            const commentData = await githubService.getCommentData({ id })
            if (commentData?.title) {
                mainNamespace.emit('updatedDiscussion', commentData)
                await redis.HSET('commented', commentData.title, totalCommentCount) // commentData.title === pid
            }
        }).on('subscribe-daily', async (email, callback) => {
            const result = await addContactToDailyList(email)
            callback(result)
        }).on('disconnect', async (reason) => {
            logger.info({ namespace, message: reason })
        })
    })
}

module.exports = router

process.on('SIGUSR2', async () => {
    const socketsKeys = await redis.KEYS(`clients-*`)
    await Promise.all([
        ...socketsKeys.map(key => redis.DEL(key, 0, -1))
    ])
})