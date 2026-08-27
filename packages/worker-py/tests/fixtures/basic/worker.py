from workers import Response, WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response("hello from Python")

    async def scheduled(self, controller, env, ctx):
        return None
