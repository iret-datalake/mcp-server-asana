import Asana from 'asana';
import { get } from 'http';

export class AsanaClientWrapper {
  private workspaces: any;
  private projects: any;
  private tasks: any;
  private stories: any;
  private projectStatuses: any;
  private tags: any;
  private customFieldSettings: any;
  private attachments: any;

  constructor(token: string) {
    const client = Asana.ApiClient.instance;
    client.authentications['token'].accessToken = token;

    // Initialize API instances
    this.workspaces = new Asana.WorkspacesApi();
    this.projects = new Asana.ProjectsApi();
    this.tasks = new Asana.TasksApi();
    this.stories = new Asana.StoriesApi();
    this.projectStatuses = new Asana.ProjectStatusesApi();
    this.tags = new Asana.TagsApi();
    this.customFieldSettings = new Asana.CustomFieldSettingsApi();
    this.attachments = new Asana.AttachmentsApi();
  }

  async listWorkspaces(opts: any = {}) {
    const response = await this.workspaces.getWorkspaces(opts);
    return response.data;
  }

  async searchProjects(workspace: string, namePattern: string, archived: boolean = false, opts: any = {}) {
    const response = await this.projects.getProjectsForWorkspace(workspace, {
      archived,
      ...opts
    });
    const pattern = new RegExp(namePattern, 'i');
    return response.data.filter((project: any) => pattern.test(project.name));
  }

  async searchTasks( searchOpts: any = {}) {
    // Extract known parameters
    const {
      input_workspace,
      text,
      resource_subtype,
      completed,
      is_subtask,
      has_attachment,
      is_blocked,
      is_blocking,
      sort_by,
      sort_ascending,
      opt_fields,
      ...otherOpts
    } = searchOpts;

    // Build search parameters
    const searchParams: any = {
      ...otherOpts // Include any additional filter parameters
    };

    // Handle custom fields if provided
    if (searchOpts.custom_fields) {
      if ( typeof searchOpts.custom_fields == "string" ) {
        try {
          searchOpts.custom_fields = JSON.parse( searchOpts.custom_fields );
        } catch ( err ) {
          if (err instanceof Error) {
            err.message = "custom_fields must be a JSON object : " + err.message;
          }
          throw err;
        }
      }
      Object.entries(searchOpts.custom_fields).forEach(([key, value]) => {
        searchParams[`custom_fields.${key}`] = value;
      });
      delete searchParams.custom_fields; // Remove the custom_fields object since we've processed it
    }

    // Add optional parameters if provided
    if (text) searchParams.text = text;
    if (resource_subtype) searchParams.resource_subtype = resource_subtype;
    if (completed !== undefined) searchParams.completed = completed;
    if (is_subtask !== undefined) searchParams.is_subtask = is_subtask;
    if (has_attachment !== undefined) searchParams.has_attachment = has_attachment;
    if (is_blocked !== undefined) searchParams.is_blocked = is_blocked;
    if (is_blocking !== undefined) searchParams.is_blocking = is_blocking;
    if (sort_by) searchParams.sort_by = sort_by;
    if (sort_ascending !== undefined) searchParams.sort_ascending = sort_ascending;
    const defaultFields = 'gid,name,completed,created_at,modified_at,resource_subtype,custom_fields,assignee.name';
    if (opt_fields) searchParams.opt_fields = opt_fields+','+defaultFields || defaultFields;
    const workspace = input_workspace || process.env.ASANA_DEFAULT_WORKSPACE || 'default_workspace_gid'

    const response = await this.tasks.searchTasksForWorkspace(workspace, searchParams);

    // Transform the response to simplify custom fields if present
    const transformedData = response.data.map((task: any) => {
      if (!task.custom_fields) return task;

      return {
        ...task,
        custom_fields: task.custom_fields.reduce((acc: any, field: any) => {
          const key = `${field.name} (${field.gid})`;
          let value = field.display_value;

          // For enum fields with a value, include the enum option GID
          if (field.type === 'enum' && field.enum_value) {
            value = `${field.display_value} (${field.enum_value.gid})`;
          }

          acc[key] = value;
          return acc;
        }, {})
      };
    }).map((task: any) => { 
      // add permalink to the task
      task.permalink = `https://app.asana.com/0/0/${task.gid}`;
      return task;
    });

    return transformedData;
  }

  async getTask(task_gid: string, opts: any = {}) {
    const response = await this.tasks.getTask(task_gid, opts);

    const {custom_fields , ...transformedData} = response.data
    // get the subtasks for the task
    transformedData.subtasks = await this.getSubtasksForTask(task_gid);
    // get the stories comments for the task
    const stories = await this.getStoriesForTask(task_gid);
    transformedData.comments = stories.filter(
      (story: any) => 
        story.resource_subtype === 'comment_added'
    );

    transformedData.timeline = stories.filter(
      (story: any) => 
        story.resource_subtype !== 'comment_added'
    );

    transformedData.permalink = `https://app.asana.com/0/0/${task_gid}`;

    transformedData.dependencies = await this.getTaskDependencies(task_gid);
    transformedData.dependents = await this.getTaskDependents(task_gid);

    transformedData.attachments = await this.getAttachmentsForTask(task_gid);

    return transformedData;
  }

  async getSubtasksForTask(task_gid: string, opts: any = {}) {
    const response = await this.tasks.getSubtasksForTask(task_gid, opts)
    return response.data;
  }

  async createTask(projectId: string, data: any) {
    // Ensure projects array includes the projectId
    const projects = data.projects || [];
    if (!projects.includes(projectId)) {
      projects.push(projectId);
    }

    const taskData = {
      data: {
        ...data,
        projects,
        // Handle resource_subtype if provided
        resource_subtype: data.resource_subtype || 'default_task',
        // Handle custom_fields if provided
        custom_fields: data.custom_fields || {}
      }
    };
    const response = await this.tasks.createTask(taskData);
    return response.data;
  }

  async getStoriesForTask(task_gid: string, opts: any = {}) {
    const response = await this.stories.getStoriesForTask(task_gid, opts);
    return response.data;
  }

  async getCommentsForTask(task_gid: string, opts: any = {}) {
    const response = await this.getStoriesForTask(task_gid, opts);
    // Filter stories to only include comments
    const comments = response.data.filter(
      (story: any) => 
        story.resource_subtype === 'comment_added'
    );
    return comments;
  }

  async getTimelineForTask(task_gid: string, opts: any = {}) {
    const response = await await this.getStoriesForTask(task_gid, opts);
    // Filter stories to only include timeline events
    const timeline = response.data.filter(
      (story: any) => 
        story.resource_subtype !== 'comment_added'
    );
    return timeline;
  }

  async updateTask(task_gid: string, data: any) {
    const body = {
      data: {
        ...data,
        // Handle resource_subtype if provided
        resource_subtype: data.resource_subtype || undefined,
        // Handle custom_fields if provided
        custom_fields: data.custom_fields || undefined
      }
    };
    const opts = {};
    const response = await this.tasks.updateTask(body, task_gid, opts);
    return response.data;
  }

  async getProject(projectId: string, opts: any = {}) {
    // Only include opts if opt_fields was actually provided
    const options = opts.opt_fields ? opts : {};
    const response = await this.projects.getProject(projectId, options);
    return response.data;
  }

  async getProjectCustomFieldSettings(projectId: string, opts: any = {}) {
    try {
      const options = {
        limit: 100,
        opt_fields: opts.opt_fields || "custom_field,custom_field.name,custom_field.gid,custom_field.resource_type,custom_field.type,custom_field.description,custom_field.enum_options,custom_field.enum_options.name,custom_field.enum_options.gid,custom_field.enum_options.enabled"
      };

      const response = await this.customFieldSettings.getCustomFieldSettingsForProject(projectId, options);
      return response.data;
    } catch (error) {
      console.error(`Error fetching custom field settings for project ${projectId}:`, error);
      return [];
    }
  }

  async getProjectTaskCounts(projectId: string, opts: any = {}) {
    // Only include opts if opt_fields was actually provided
    const options = opts.opt_fields ? opts : {};
    const response = await this.projects.getTaskCountsForProject(projectId, options);
    return response.data;
  }

  async getProjectSections(projectId: string, opts: any = {}) {
    // Only include opts if opt_fields was actually provided
    const options = opts.opt_fields ? opts : {};
    const sections = new Asana.SectionsApi();
    const response = await sections.getSectionsForProject(projectId, options);
    return response.data;
  }

  async createTaskStory(task_gid: string, text: string | null = null, opts: any = {}, html_text: string | null = null) {
    const options = opts.opt_fields ? opts : {};
    const data: any = {};

    if (text) {
      data.text = text;
    } else if (html_text) {
      data.html_text = html_text;
    } else {
      throw new Error("Either text or html_text must be provided");
    }

    const body = { data };
    const response = await this.stories.createStoryForTask(body, task_gid, options);
    return response.data;
  }

  async addTaskDependencies(task_gid: string, dependencies: string[]) {
    const body = {
      data: {
        dependencies: dependencies
      }
    };
    const response = await this.tasks.addDependenciesForTask(body, task_gid);
    return response.data;
  }

  async addTaskDependents(task_gid: string, dependents: string[]) {
    const body = {
      data: {
        dependents: dependents
      }
    };
    const response = await this.tasks.addDependentsForTask(body, task_gid);
    return response.data;
  }

  async createSubtask(parenttask_gid: string, data: any, opts: any = {}) {
    const taskData = {
      data: {
        ...data
      }
    };
    const response = await this.tasks.createSubtaskForTask(taskData, parenttask_gid, opts);
    return response.data;
  }

  async setParentForTask(data: any, task_gid: string, opts: any = {}) {
    const response = await this.tasks.setParentForTask({ data }, task_gid, opts);
    return response.data;
  }

  async getTaskDependencies(task_gid: string, opts: any = {}) {
    const response = await this.tasks.getDependenciesForTask(task_gid, opts);
    return response.data;
  }

  async getTaskDependents(task_gid: string, opts: any = {}) {
    const response = await this.tasks.getDependentsForTask(task_gid, opts);
    return response.data;
  }

  async getProjectStatus(statusId: string, opts: any = {}) {
    const response = await this.projectStatuses.getProjectStatus(statusId, opts);
    return response.data;
  }

  async getProjectStatusesForProject(projectId: string, opts: any = {}) {
    const response = await this.projectStatuses.getProjectStatusesForProject(projectId, opts);
    return response.data;
  }

  async createProjectStatus(projectId: string, data: any) {
    const body = { data };
    const response = await this.projectStatuses.createProjectStatusForProject(body, projectId);
    return response.data;
  }

  async deleteProjectStatus(statusId: string) {
    const response = await this.projectStatuses.deleteProjectStatus(statusId);
    return response.data;
  }

  async getMultipleTasksByGid(task_gids: string[], opts: any = {}) {
    if (task_gids.length > 25) {
      throw new Error("Maximum of 25 task IDs allowed");
    }

    // Use Promise.all to fetch tasks in parallel
    const tasks = await Promise.all(
      task_gids.map(task_gid => this.getTask(task_gid, opts))
    );

    return tasks;
  }

  async getTasksForTag(tag_gid: string, opts: any = {}) {
    const response = await this.tasks.getTasksForTag(tag_gid, opts);
    return response.data;
  }

  async getTagsForWorkspace(workspace_gid: string, opts: any = {}) {
    const response = await this.tags.getTagsForWorkspace(workspace_gid, opts);
    return response.data;
  }

  async getAttachmentsForTask( task_gid: string, opts: any = {} ) {
    const response = await this.attachments.getAttachmentsForObject(task_gid, opts = {
        opt_fields: "gid"
    });

    // return response.data;

    const attachments = await Promise.all(
    response.data.map(async (attachment: any) => {
      const detailedAttachment = await this.attachments.getAttachment(attachment.gid, opts = {
        opt_fields: "gid,name,download_url,resource_subtype"
      });
      return detailedAttachment.data; //  Returnthe detailed attachment data
    }));
    
    return attachments;
  }

}
