const { get, pick } = require('lodash')
const prettier = require('prettier')
const { bold } = require('kleur')

module.exports = prettierBot

/**
 *
 * @param {import('probot').Application} app The Probot application instance
 */
function prettierBot(app) {
  app.on('pull_request.synchronize', async context => {
    let { before, after } = context.payload

    // Get commits since last push.
    let commitsResponse = await context.github.repos.compareCommits(
      context.repo({ base: before, head: after })
    )

    if (!isOk(commitsResponse)) {
      // TODO handle error
      return
    }

    // Get file contents of changed/added files in the commit comparison.
    let filesResponse = await Promise.all(
      commitsResponse.data.files.map(file => {
        return context.github.request({
          method: 'GET',
          url: file.contents_url,
        })
      })
    )

    let changes = new Map()
    for (let fileResponse of filesResponse) {
      if (!isOk(fileResponse)) {
        context.log.warn('Error fetching file contents')
        // TODO handle error
        continue
      }

      let { content, name, sha } = fileResponse.data

      // TODO should probably pass the file path instead of just the file name
      let { ignored, inferredParser } = await prettier.getFileInfo(name)
      if (ignored) {
        context.log.debug(
          'File %s is ignored in the Prettier config - skipping',
          bold(name)
        )
        continue
      }
      if (inferredParser === null) {
        context.log.debug('No parser available for %s - skipping', bold(name))
        continue
      }

      let originalSource = base64ToUtf8(content)
      let formattedSource = prettier.format(originalSource, {
        filepath: name,
        // TODO figure out how to resolve Prettier configuration
      })

      if (originalSource === formattedSource) {
        context.log.debug(
          'Nothing changed when Prettier formatted file %s',
          bold(name)
        )
      } else {
        context.log.debug('Prettier was able to format file %s', bold(name))
        changes.set(sha, formattedSource)
      }
    }

    if (changes.size === 0) {
      context.log.debug('No changes to be made')
      return
    }

    let treeResponse = await context.github.gitdata.getTree(
      context.repo({ tree_sha: after })
    )
    if (!isOk(treeResponse)) {
      context.log.error('Unable to find tree for sha %s', bold(after))
      return
    }

    let oldToNew = new Map()
    for (let [sha, content] of [...changes]) {
      // create new blobs and get new SHAs
      let blobResponse = await context.github.gitdata.createBlob(
        context.repo({ content, encoding: 'utf-8' })
      )
      if (!isOk(blobResponse)) {
        // TODO handle error
        context.log.error('Unable to create blob for %s', bold(sha))
        context.log.debug('createBlob response', blobResponse)
        continue
      }

      let newSha = get(blobResponse.data, 'sha')
      oldToNew.set(sha, newSha)
    }

    if (oldToNew.size !== changes.size) {
      context.log.error('Wtf happened')
      return
    }

    let createTreeResponse = await context.github.gitdata.createTree(
      context.repo({
        baseTree: treeResponse.data.sha,
        tree: treeResponse.data.tree.map(obj => {
          if (oldToNew.has(obj.sha)) {
            let sha = oldToNew.get(obj.sha)
            return { ...pick(obj, ['path', 'mode', 'type']), sha }
          } else {
            return pick(obj, ['path', 'mode', 'type', 'sha'])
          }
        }),
      })
    )
    if (!isOk(createTreeResponse)) {
      context.log.error('Unable to create updated file tree')
      return
    }

    let createCommitResponse = await context.github.gitdata.createCommit(
      context.repo({
        parents: [after],
        tree: createTreeResponse.data.sha,
        message: '[prettierbot] make files pretty 💅',
      })
    )
    if (!isOk(createCommitResponse)) {
      context.log.error('Unable to create new commit')
      return
    }

    let branchName = context.payload.pull_request.head.ref
    let updateRefResponse = await context.github.gitdata.updateRef(
      context.repo({
        ref: `heads/${branchName}`,
        sha: createCommitResponse.data.sha,
      })
    )
    if (!isOk(updateRefResponse)) {
      context.log.error('Unable to update PR branch with new commit')
      return
    }
  })
}

function isOk(response) {
  return response.status >= 200 && response.status < 300
}

function base64ToUtf8(content) {
  return Buffer.from(content, 'base64').toString('utf8')
}
